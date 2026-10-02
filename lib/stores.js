/**
 * lib/stores.js —— 三张表的仓储（state / events / prefs），共用 kv-records-base 的域登记表。
 *
 * 与 sysops 同口径：域名字排他，同一设施同一域只 open 一次；
 * 写全部走串行队列（KV 没有事务，串行是唯一能保证「谁最后写」确定的办法）；
 * 脏行在 put 之前被 schema 挡下并包成带 code 的 INVALID。
 */
import { MODELWATCH_DOMAIN, DEFAULT_PREFS, CHECK_INTERVALS, TOP_N_MIN, TOP_N_MAX, KEEP_EVENTS_MIN, KEEP_EVENTS_MAX } from './domain.js';
import { acquireDomain, releaseDomain, createRecordRepo, RecordsError, RECORDS_ERROR } from './kv-records-base.js';
import { requiredString } from './kv-schema.js';

const STATE_KEY = 'latest';
const PREFS_KEY = 'prefs';

/** 三表同域：各仓储都经同一张登记表拿 handle（refs 记账在 kv-records-base）。 */
function repoFor({ getFacility, logger }, table) {
  return createRecordRepo({ getFacility, logger, domain: MODELWATCH_DOMAIN, table });
}

export function createStateStore(opts = {}) {
  const repo = repoFor(opts, 'state');
  return {
    get available() { return repo.available; },
    close: () => repo.close(),
    read() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(STATE_KEY);
        return row === undefined ? null : row;
      });
    },
    write(row) {
      return repo.enqueue(async () => {
        const value = repo.parseOrInvalid(row);
        const t = await repo.tableOf();
        await t.put(STATE_KEY, value);
        return value;
      });
    },
  };
}

/** 追加式变更流水：id = `e-<毫秒>-<同毫秒序号>`（宿主发号，前端不许自带 id）。 */
export function createEventStore(opts = {}) {
  const repo = repoFor(opts, 'events');
  const now = opts.now ?? (() => Date.now());
  let seq = 0;
  let lastAt = -1;

  async function allRows(t) {
    return [...t.entries()].map(([, v]) => v).sort((a, b) => b.at - a.at || (b.id < a.id ? -1 : 1));
  }

  return {
    get available() { return repo.available; },
    close: () => repo.close(),
    append({ kind, slug, detail }) {
      return repo.enqueue(async () => {
        requiredString('事件种类').parse(kind);
        const at = now();
        if (at === lastAt) seq += 1; else { lastAt = at; seq = 0; }
        const row = repo.parseOrInvalid({ id: `e-${at}-${seq}`, at, kind, slug, detail });
        const t = await repo.tableOf();
        await t.put(row.id, row);
        return row;
      });
    },
    list(limit = 100) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const rows = await allRows(t);
        const n = Number(limit);
        const eff = Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(1, Math.trunc(n))) : 100;
        return rows.slice(0, eff);
      });
    },
    /** 裁剪到 keep 条：只按条数裁、不按期裁（流水本就该短平快）。 */
    trim(keep) {
      return repo.enqueue(async () => {
        const n = Number(keep);
        if (!Number.isFinite(n) || n < 1) return 0;
        const t = await repo.tableOf();
        const rows = await allRows(t);
        const doomed = rows.slice(n);
        for (const row of doomed) await t.delete(row.id);
        return doomed.length;
      });
    },
  };
}

/** 偏好：整行一份；读时与 DEFAULT_PREFS 合并（库里 null = 从未写入）。 */
export function createPrefsStore(opts = {}) {
  const repo = repoFor(opts, 'prefs');
  function clampPrefs(raw) {
    const p = { ...DEFAULT_PREFS, ...(raw && typeof raw === 'object' ? raw : {}) };
    if (!CHECK_INTERVALS.includes(p.intervalMin)) p.intervalMin = DEFAULT_PREFS.intervalMin;
    p.topN = Math.min(TOP_N_MAX, Math.max(TOP_N_MIN, Number(p.topN) || DEFAULT_PREFS.topN));
    p.keepEvents = Math.min(KEEP_EVENTS_MAX, Math.max(KEEP_EVENTS_MIN, Number(p.keepEvents) || DEFAULT_PREFS.keepEvents));
    return p;
  }
  return {
    get available() { return repo.available; },
    close: () => repo.close(),
    read() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(PREFS_KEY);
        return clampPrefs(row === undefined ? null : row);
      }).catch((e) => {
        // 域不可用不是崩溃：回落默认值，界面经 available 位知道「写不进去」（spec §4 末段）。
        if (e?.code === RECORDS_ERROR.UNAVAILABLE || e?.code === RECORDS_ERROR.CLOSED) return clampPrefs(null);
        throw e;
      });
    },
    /** 读-并-写整行：只发半份 = 把其余键静默抹掉（sysops 最终评审 Critical-1 同条教训）。 */
    patch(fields) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const cur = t.get(PREFS_KEY) ?? {};
        const merged = clampPrefs({ ...cur, ...(fields && typeof fields === 'object' ? fields : {}) });
        const value = repo.parseOrInvalid(merged);
        await t.put(PREFS_KEY, value);
        return value;
      });
    },
  };
}

export { RecordsError, RECORDS_ERROR, acquireDomain, releaseDomain };
