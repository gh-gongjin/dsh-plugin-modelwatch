/**
 * test/_helpers.mjs —— 零框架跑测器（口径继承 sysops）：
 *   node test/<x>.test.mjs 直跑；用例名含「真机」时 SKIP_LOCAL=1 跳过并打印 SKIP。
 * 断言一律 node:assert/strict；check 不看 id 唯一性 ⇒ 每个套件收尾前自己扫一遍重号。
 */
import assert from 'node:assert/strict';

const cases = [];
export function check(name, fn) { cases.push({ name, fn }); }

export async function runAll(suiteLabel) {
  const skipLocal = process.env.SKIP_LOCAL === '1';
  let pass = 0; let skip = 0; const fails = [];
  for (const c of cases) {
    if (skipLocal && c.name.includes('真机')) { skip += 1; console.log(`SKIP ${c.name}`); continue; }
    try {
      await c.fn();
      pass += 1;
    } catch (e) {
      fails.push({ name: c.name, e });
      console.log(`FAIL ${c.name}\n  ${e?.message ?? e}`);
    }
  }
  console.log(`\n[${suiteLabel}] pass ${pass} / fail ${fails.length} / skip ${skip}`);
  if (fails.length) process.exitCode = 1;
}

export { assert };

/** 读夹具文本（UTF-8）。 */
export async function fixture(name) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return fs.readFileSync(url, 'utf8');
}
export async function fixtureJson(name) {
  return JSON.parse(await fixture(name));
}

/**
 * 假 storageDomain 设施：open 计数 + already-open 语义（域名排他，同 sysops 血案口径）。
 * handle.table(name) → { get, put, delete, entries, close }
 */
export function makeFakeFacility() {
  const openDomains = new Map();
  const calls = { open: 0, close: 0 };
  return {
    calls,
    async open(domain) {
      calls.open += 1;
      if (openDomains.has(domain.name)) throw new Error(`already-open: ${domain.name}`);
      const tables = new Map();
      const state = { closed: false };
      const handle = {
        table(name) {
          if (state.closed) throw new Error('CLOSED');
          if (!tables.has(name)) {
            const rows = new Map();
            tables.set(name, {
              get: (k) => (rows.has(k) ? rows.get(k) : undefined),
              put: async (k, v) => { rows.set(k, v); },
              delete: async (k) => { rows.delete(k); },
              entries: () => [...rows.entries()],
            });
          }
          return tables.get(name);
        },
        async close() { state.closed = true; openDomains.delete(domain.name); calls.close += 1; },
      };
      openDomains.set(domain.name, handle);
      return handle;
    },
  };
}

/** 假 HTTP：按 URL 前缀路由到预置响应；记录请求次数。 */
export function makeFakeFetch(routes) {
  const seen = [];
  const fetchFn = async (url, opts = {}) => {
    seen.push(url);
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    if (!key) throw new Error(`假 fetch 没登记这个 URL：${url}`);
    const r = routes[key];
    if (typeof r === 'function') return r(url, opts);
    return {
      ok: r.status === undefined ? true : r.status >= 200 && r.status < 300,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => r.text,
    };
  };
  fetchFn.seen = seen;
  return fetchFn;
}

/** 假 res：捕获 writeHead/end/write，供 api 层断言状态码与 body。 */
export function makeRes() {
  const res = {
    head: null, body: '', statusCode: 0, ended: false, writes: [],
    writeHead(status, headers) { this.statusCode = status; this.head = headers; },
    end(chunk) { this.body += chunk ?? ''; this.ended = true; },
    write(chunk) { if (this.ended) throw new Error('write after end'); this.writes.push(String(chunk)); return true; },
    on() {},
    json() { try { return JSON.parse(this.body); } catch { return null; } },
  };
  return res;
}
