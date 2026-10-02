/**
 * lib/check.js —— 一轮检查的编排：读旧档 → 两个源各自拉取 → 各自判定 → 落流水与快照 → 推帧。
 *
 * 三条铁律在这一层的落点：
 *  · 两个源**独立失败**：清单坏了不拦榜单，反之亦然；坏在哪一侧就只标注哪一侧。
 *  · 首轮只建档不产 diff 事件（spec §3）；源从坏转好那一轮也不补产积压 enter —— 拿不到公允的上轮就不记账。
 *  · 定时器缺宿主 ctx.timer 时退 setInterval（unref + dispose 显式清），能力位由装配层如实标。
 */
import { fetchModels, newThisWeek, newRecentForState, diffIds } from './services/models.js';
import { fetchRankings } from './services/rankings.js';
import { TOP_MOVE_THRESHOLD, NEW_WINDOW_DAYS_SHOW } from './domain.js';

/** slug 集合差：本轮进/出了谁。 */
function topDiff(prevSlugs, nextSlugs) {
  const prev = new Set(prevSlugs);
  const next = new Set(nextSlugs);
  return {
    entered: nextSlugs.filter((s) => !prev.has(s)),
    exited: prevSlugs.filter((s) => !next.has(s)),
  };
}

export function createCheckService(deps = {}) {
  const {
    getPrefs, stateStore, eventStore, logger,
    now = () => Date.now(),
    getIntervalFn = () => undefined,
    fetchModelsFn = fetchModels,
    fetchRankingsFn = fetchRankings,
    onEvent = null,
  } = deps;

  let running = null;      // 正在跑的那一轮的 promise（busy 单闸）
  let timerHandle = null;
  let timerBackend = 'none';

  async function appendEvent(kind, { slug = '', detail = '' } = {}) {
    try {
      await eventStore.append({ kind, slug, detail });
    } catch (e) {
      // 流水写不进（多半是无存储）：留痕进日志，绝不让一轮检查因此中断。
      logger?.warn?.(`[modelwatch] 事件落库失败（${kind}）：${e?.message ?? e}`);
    }
  }

  function emit(type, payload = {}) {
    try { onEvent?.({ type, ...payload }); } catch { /* 推帧失败 = 没人订阅，无需解释 */ }
  }

  /** 两个源各拉一次；返回本轮的完整判定结果（stateStore 不可写时照常算完再尽力落库）。 */
  async function runOnce({ trigger = 'timer' } = {}) {
    const prefs = getPrefs();
    const t0 = now();
    let prev = null;
    let stateWritable = true;
    try {
      prev = await stateStore.read();
    } catch (e) {
      stateWritable = false;
      logger?.warn?.(`[modelwatch] 读旧档失败：${e?.message ?? e}`);
    }

    const [modelsRes, rankRes] = await Promise.all([
      fetchModelsFn({ timeoutMs: deps.modelsTimeoutMs ?? 20000 }),
      fetchRankingsFn({ timeoutMs: deps.rankTimeoutMs ?? 30000 }),
    ]);

    const produced = { new_model: 0, removed_model: 0, top_enter: 0, top_exit: 0, top_move: 0, source_error: 0, source_recover: 0 };
    const firstRun = !prev;

    /* ---- 清单侧 ---- */
    let modelCount = prev?.modelCount ?? 0;
    let modelIds = prev?.modelIds ?? [];
    let newRecent = prev?.newRecent ?? [];
    const modelsOk = modelsRes.ok === true;
    if (modelsOk) {
      const rows = modelsRes.rows;
      modelCount = rows.length;
      const nextIds = rows.map((r) => r.id);
      const diff = diffIds(prev?.modelIds, nextIds);
      if (diff.firstRun) {
        await appendEvent('baseline', { detail: '首次建档：本轮起开始对比' });
      } else {
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const id of diff.added) {
          await appendEvent('new_model', { slug: id, detail: byId.get(id)?.name ?? '' });
          produced.new_model += 1;
        }
        for (const id of diff.removed) {
          await appendEvent('removed_model', { slug: id });
          produced.removed_model += 1;
        }
      }
      modelIds = nextIds;
      newRecent = newRecentForState(rows, t0);
      if (prev && prev.modelsOk === false) {
        await appendEvent('source_recover', { detail: '模型清单源恢复' });
        produced.source_recover += 1;
      }
    } else if (!prev || prev.modelsOk !== false) {
      // 只在「状态翻转」或首轮就坏时记一笔；连续坏不刷屏（spec §1 末段）
      await appendEvent('source_error', { detail: `模型清单源：${modelsRes.error}` });
      produced.source_error += 1;
    }

    /* ---- 榜单侧 ---- */
    const rankOk = rankRes.ok === true;
    let top = prev?.top ?? [];
    let prevTop = prev?.prevTop ?? [];
    if (rankOk) {
      const prevRankBySlug = new Map((prev?.top ?? []).map((r) => [r.slug, r.rank]));
      const canDiff = Boolean(prev) && Array.isArray(prev.top) && prev.top.length > 0 && prev.rankOk === true;
      top = rankRes.rows.map((r, i) => {
        const row = { rank: i + 1, slug: r.slug, tokens: r.tokens };
        if (canDiff && prevRankBySlug.has(r.slug)) {
          const d = prevRankBySlug.get(r.slug) - row.rank; // 正数 = 名次上升
          if (d !== 0) row.delta = d;
        }
        return row;
      });
      prevTop = (prev?.top ?? []).map((r) => r.slug);
      if (canDiff) {
        const nextSlugs = top.map((r) => r.slug);
        const td = topDiff(prevTop, nextSlugs);
        for (const s of td.entered) { await appendEvent('top_enter', { slug: s }); produced.top_enter += 1; }
        for (const s of td.exited) { await appendEvent('top_exit', { slug: s }); produced.top_exit += 1; }
        for (const row of top) {
          const oldRank = prevRankBySlug.get(row.slug);
          if (oldRank === undefined) continue;
          const move = oldRank - row.rank;
          if (Math.abs(move) >= TOP_MOVE_THRESHOLD) {
            await appendEvent('top_move', { slug: row.slug, detail: `${oldRank} → ${row.rank}` });
            produced.top_move += 1;
          }
        }
      }
      if (prev && prev.rankOk === false) {
        await appendEvent('source_recover', { detail: '热门周榜源恢复' });
        produced.source_recover += 1;
      }
    } else if (!prev || prev.rankOk !== false) {
      await appendEvent('source_error', { detail: `热门周榜源：${rankRes.reason}` });
      produced.source_error += 1;
    }

    /* ---- 落库（尽力而为）---- */
    const stateRow = {
      at: t0,
      modelCount, modelIds, newRecent, top, prevTop,
      baseline: firstRun,
      modelsOk, modelsError: modelsOk ? undefined : modelsRes.error,
      rankOk, rankError: rankOk ? undefined : rankRes.reason,
    };
    if (stateWritable) {
      try {
        await stateStore.write(stateRow);
        await eventStore.trim(prefs.keepEvents);
      } catch (e) {
        logger?.warn?.(`[modelwatch] 落库失败：${e?.message ?? e}`);
      }
    }
    emit('update', { trigger, produced, at: t0 });
    return { at: t0, produced, modelsOk, rankOk, firstRun };
  }

  return {
    /** 单闸：同一时刻只跑一轮；正在跑时再触发返回 409 语义的 CHECK_BUSY。 */
    run(opts = {}) {
      if (running) {
        // 必须走 rejected promise 而不是同步 throw：定时器等同步调用方接不住 throw，会打崩宿主进程。
        return Promise.reject(Object.assign(new Error('已有一轮检查在跑，等它结束'), { code: 'CHECK_BUSY' }));
      }
      running = runOnce(opts).finally(() => { running = null; });
      return running;
    },
    get running() { return running !== null; },

    /** 展示口径单点：从 state.newRecent 里取近 7 天（宿主算，界面不复制判定）。 */
    thisWeekFrom(stateRows, atMs) {
      return newThisWeek(stateRows ?? [], atMs ?? now());
    },
    showDays: NEW_WINDOW_DAYS_SHOW,

    setCadence(intervalMin) {
      this.stopTimer();
      const ms = Math.max(1, Number(intervalMin) || 60) * 60000;
      const host = getIntervalFn();
      if (typeof host === 'function') {
        timerHandle = host(() => { this.run({ trigger: 'timer' }).catch((e) => logger?.warn?.(`[modelwatch] 定时检查失败：${e?.message ?? e}`)); }, ms);
        timerBackend = 'ctx.timer';
      } else {
        timerHandle = setInterval(() => { this.run({ trigger: 'timer' }).catch((e) => logger?.warn?.(`[modelwatch] 定时检查失败：${e?.message ?? e}`)); }, ms);
        if (typeof timerHandle.unref === 'function') timerHandle.unref();
        timerBackend = 'setInterval';
      }
    },
    stopTimer() {
      if (timerHandle === null) return;
      try {
        // 宿主 ctx.timer.interval 返回的是 disposer 函数，不是 setInterval 的 handle；
        // 对函数调 clearInterval 是静默 no-op，旧定时器会一直活着（泄漏叠加 → CHECK_BUSY 撞崩宿主）。
        if (typeof timerHandle === 'function') timerHandle();
        else clearInterval(timerHandle);
      } catch { /* 清不掉也只可能是已经清了 */ }
      timerHandle = null;
    },
    get timerBackend() { return timerBackend; },
    dispose() { this.stopTimer(); },
  };
}
