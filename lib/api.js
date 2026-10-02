/**
 * lib/api.js —— 宿主可见的唯一 HTTP 面：路由表 + SSE hub。
 * 三件事：写操作回环闸门 → 表驱动分派 → 错误码集中翻译成 HTTP 语义。
 *
 * openSse / createHub 是 sysops lib/api.js 同名实现的同源拷贝（帧语义不许两边漂）：
 * `: ok` 冲缓冲、25s `: ping` 心跳（unref）、心跳写失败当场摘牌。
 *
 * 回环闸门只拦 POST（检查触发 / 偏好写入）：本插件对系统零破坏面，
 * GET 不闸是为了真机排障时能从别机看面板；写操作不接受远程或反代转发驱动。
 */
import { RANKINGS_SOURCE_NOTE } from './services/rankings.js';

export const ROUTE_PREFIX = '/modelwatch';
export const GLOBAL_KEY = '__MODELWATCH__';

/* ------------------------------------------------------------------ *
 * 响应 / 请求体
 * ------------------------------------------------------------------ */
export function jsonOk(res, data) {
  return json(res, 200, { ok: true, data });
}
function errBody(code, message) {
  return { ok: false, error: { code, message } };
}
export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
  return true;
}
export function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req && typeof req === 'object' && req.__parsedBody && typeof req.__parsedBody === 'object') {
      return resolve(req.__parsedBody);
    }
    if (!req || typeof req.on !== 'function') return resolve({});
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BAD_JSON' }));
        req.destroy?.();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' })); }
    });
    req.on('error', (e) => reject(Object.assign(new Error(String(e?.message ?? e)), { code: 'BAD_JSON' })));
  });
}

/* ------------------------------------------------------------------ *
 * 错误码 → HTTP 状态码（集中一张表）
 * ------------------------------------------------------------------ */
const CODE_STATUS = {
  MODELWATCH_RECORDS_UNAVAILABLE: 501,
  MODELWATCH_RECORDS_CLOSED: 503,
  MODELWATCH_RECORDS_INVALID: 400,
  MODELWATCH_RECORDS_NOT_FOUND: 404,
  MODELWATCH_RECORDS_DUPLICATE: 409,
  CHECK_BUSY: 409,
  BAD_JSON: 400,
  INVALID_PARAM: 400,
  FORBIDDEN: 403,
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
};
export function statusFor(code) {
  return CODE_STATUS[code] ?? 500;
}

/* ------------------------------------------------------------------ *
 * SSE：单条连接 + 广播 hub（同源拷贝，见文件头）
 * ------------------------------------------------------------------ */
export const SSE_HEARTBEAT_MS = 25000;

export function openSse(res, opts = {}) {
  const {
    onBroken = null,
    setIntervalMod = setInterval,
    clearIntervalMod = clearInterval,
    heartbeatMs = SSE_HEARTBEAT_MS,
  } = opts;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  res.write(': ok\n\n');
  const hb = setIntervalMod(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch {
      closed = true;
      clearIntervalMod(hb);
      onBroken?.();
    }
  }, heartbeatMs);
  if (typeof hb.unref === 'function') hb.unref();
  return {
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearIntervalMod(hb);
    },
  };
}

export function createHub(onFirst, onLast) {
  const clients = new Set();
  const api = {
    add(client) {
      clients.add(client);
      if (clients.size === 1) onFirst?.();
    },
    remove(client) {
      if (!clients.delete(client)) return;
      try { client.close?.(); } catch { /* 关不上的连接已断，无需解释 */ }
      if (clients.size === 0) onLast?.();
    },
    get count() { return clients.size; },
    broadcast(event, data) {
      for (const c of [...clients]) {
        try { c.send(event, data); } catch { api.remove(c); }
      }
    },
    dispose() {
      for (const c of [...clients]) api.remove(c);
    },
  };
  return api;
}

/* ------------------------------------------------------------------ *
 * 快照装配（一份真相：字段表见 spec §8）
 * ------------------------------------------------------------------ */
export async function snapshotOf(deps) {
  const { check, stateStore, eventStore, prefsStore, caps, now } = deps;
  const t = now();
  let state = null;
  let stateRead = true;
  try { state = await stateStore.read(); } catch { stateRead = false; }
  let events = [];
  try { events = await eventStore.list(100); } catch { /* 无存储：空列表 + available 位说真话 */ }
  const prefs = await prefsStore.read();
  const top = (state?.top ?? []).slice(0, prefs.topN);
  return {
    at: t,
    caps: caps.read(),
    capabilityRows: caps.rows(),
    prefs,
    storage: { available: Boolean(stateStore.available) && stateRead },
    sources: {
      models: { ok: state ? state.modelsOk === true : false, error: state?.modelsError ?? (stateRead ? '还没跑过第一轮检查' : '存储不可用'), checkedAt: state?.at ?? 0 },
      rankings: { ok: state ? state.rankOk === true : false, error: state?.rankError ?? (stateRead ? '还没跑过第一轮检查' : '存储不可用'), checkedAt: state?.at ?? 0, unofficial: true, note: RANKINGS_SOURCE_NOTE },
    },
    models: {
      count: state?.modelCount ?? 0,
      firstRun: Boolean(state?.baseline),
      newThisWeek: check.thisWeekFrom(state?.newRecent, t),
    },
    top: { rows: top, days: 7, note: RANKINGS_SOURCE_NOTE },
    events,
  };
}

/* ------------------------------------------------------------------ *
 * 路由表
 * ------------------------------------------------------------------ */
export const ROUTES = {
  'GET /api/snapshot': {
    handler: (deps) => async (req, res) => jsonOk(res, await snapshotOf(deps)),
  },
  'GET /api/stream': {
    handler: (deps) => async (req, res) => {
      const hub = deps.hub;
      let client;
      const sse = openSse(res, { onBroken: () => hub.remove(client), ...(deps.sseTimers ?? {}) });
      client = { send: sse.send, close: sse.close };
      hub.add(client);
      res.on?.('close', () => hub.remove(client));
      sse.send('snapshot', await snapshotOf(deps));
      return true; // 不 end：保持长连接
    },
  },
  'POST /api/check': {
    handler: (deps) => async (req, res) => jsonOk(res, await deps.check.run({ trigger: 'manual' })),
  },
  'GET /api/events': {
    handler: (deps) => async (req, res, body, url) => {
      const raw = url?.searchParams?.get('limit');
      const n = Number(raw);
      const limit = Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(1, Math.trunc(n))) : 100;
      return jsonOk(res, { events: await deps.eventStore.list(limit) });
    },
  },
  'GET /api/prefs': {
    handler: (deps) => async (req, res) => jsonOk(res, await deps.prefsStore.read()),
  },
  'POST /api/prefs': {
    handler: (deps) => async (req, res, body) => {
      const patch = {};
      for (const [k, v] of Object.entries(body && typeof body === 'object' ? body : {})) {
        if (k === 'intervalMin' || k === 'topN' || k === 'keepEvents') patch[k] = v;
      }
      const saved = await deps.prefsStore.patch(patch);
      await deps.onPrefsChanged?.();
      return jsonOk(res, saved);
    },
  },
};

/** 某 path 上被登记的方法集合（405 判定用）。 */
function methodsForPath(path) {
  const out = [];
  for (const key of Object.keys(ROUTES)) {
    const [m, p] = key.split(' ');
    if (p === path) out.push(m);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 回环闸门（仅 POST，见文件头）
 * ------------------------------------------------------------------ */
function isLoopIp(ip) {
  const s = String(ip ?? '').replace(/^\[|\]$/g, '');
  return /^127\./.test(s) || s === '::1' || s.toLowerCase() === 'localhost';
}
export function isLoopback(req) {
  const ip = req?.socket?.remoteAddress ?? '';
  if (!isLoopIp(ip)) return false;
  const xff = req?.headers?.['x-forwarded-for'];
  if (xff) {
    for (const hop of String(xff).split(',')) {
      if (!isLoopIp(hop.trim())) return false;
    }
  }
  return true;
}

function toUrl(raw) {
  if (raw instanceof URL) return raw;
  if (raw && typeof raw === 'object' && typeof raw.pathname === 'string') return raw;
  return new URL(String(raw ?? '/'), 'http://127.0.0.1');
}
function stripPrefix(pathname) {
  if (pathname.startsWith(ROUTE_PREFIX)) {
    const rest = pathname.slice(ROUTE_PREFIX.length);
    return rest === '' ? '/' : rest;
  }
  return pathname;
}

/**
 * 造路由 handler。deps 需带 check/stateStore/eventStore/prefsStore/caps/logger/now，
 * 可选 subscribeEvent(fn)->unsub（check 服务的帧汇进 hub 广播）。
 */
export function createApiHandler(deps) {
  const hub = createHub();
  const d = { ...deps, hub };
  const unsubs = [];
  if (typeof deps.subscribeEvent === 'function') {
    const unsub = deps.subscribeEvent((ev) => {
      // 检查完推 'update'：载荷直接给全量快照 —— 帧的形状就是 GET snapshot 的形状，
      // 浏览器半边合并时无需凭空补任何字段（sysops S17 的教训）。
      if (ev?.type === 'update') {
        Promise.resolve(snapshotOf(d))
          .then((snap) => hub.broadcast('update', snap))
          .catch((e) => deps.logger?.warn?.(`[modelwatch] update 帧装配失败：${e?.message ?? e}`));
      }
    });
    if (typeof unsub === 'function') unsubs.push(unsub);
  }

  async function handler(req, res, bodyArg) {
    const url = toUrl(req.url);
    const path = stripPrefix(url.pathname);
    const method = req.method ?? 'GET';

    if (method === 'POST' && !isLoopback(req)) {
      return json(res, 403, errBody('FORBIDDEN', '写操作（触发检查 / 保存偏好）仅接受来自本机回环的请求'));
    }

    const key = `${method} ${path}`;
    const entry = ROUTES[key];
    if (!entry) {
      const allowed = methodsForPath(path);
      if (allowed.length) {
        return json(res, 405, errBody('METHOD_NOT_ALLOWED', `请求方法 ${method} 不被允许，${path} 仅支持 ${allowed.join(' | ')}`));
      }
      return json(res, 404, errBody('NOT_FOUND', `未知路由 ${method} ${path}`));
    }

    let body = bodyArg;
    if (body === undefined && method === 'POST') {
      try { body = await readBody(req); } catch (e) {
        return json(res, statusFor(e?.code), errBody(e?.code ?? 'BAD_JSON', e?.message ?? String(e)));
      }
    }
    try {
      return await entry.handler(d)(req, res, body ?? {}, url);
    } catch (e) {
      const code = typeof e?.code === 'string' ? e.code : 'INTERNAL';
      return json(res, statusFor(code), errBody(code, e?.message ?? String(e)));
    }
  }

  handler.dispose = () => {
    hub.dispose();
    for (const u of unsubs) { try { u(); } catch { /* 退订失败无需解释 */ } }
  };
  return handler;
}
