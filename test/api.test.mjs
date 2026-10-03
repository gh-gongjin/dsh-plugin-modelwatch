import { check, runAll, assert, makeRes } from './_helpers.mjs';
import {
  createApiHandler, snapshotOf, openSse, isLoopback, statusFor, ROUTES,
  ROUTE_PREFIX, GLOBAL_KEY, SSE_HEARTBEAT_MS,
} from '../lib/api.js';
import { createCaps } from '../lib/caps.js';

function depsStub(extra = {}) {
  const caps = createCaps({ logger: { warn() {} } });
  caps.mark('storageDomain', true);
  const state = {
    at: 1790700000000, modelCount: 3, modelIds: ['a/x', 'b/y', 'c/z'],
    newRecent: [
      { id: 'a/x', name: 'A X', created: 1790690000, contextLength: 128000, priceInM: 3, priceOutM: 15 },
      { id: 'b/y', name: 'B Y', created: 1750000000 },
    ],
    top: Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, slug: `s${i}/m`, tokens: (20 - i) * 1e9 })),
    freeTop: Array.from({ length: 3 }, (_, i) => ({ rank: i + 1, slug: `s${i}/m:free`, tokens: (3 - i) * 1e8 })),
    prevTop: [], baseline: false, modelsOk: true, rankOk: true, freeOk: true,
  };
  return {
    caps,
    check: { thisWeekFrom: (rows, at) => (rows ?? []).filter((r) => r.created * 1000 > at - 7 * 86400000), showDays: 7, run: async () => ({ at: 1, produced: {} }) },
    stateStore: { available: true, read: async () => state },
    eventStore: { available: true, list: async (n) => Array.from({ length: Math.min(n ?? 100, 3) }, (_, i) => ({ id: `e${i}`, at: 1790700000000 - i, kind: 'new_model', slug: `m${i}` })) },
    prefsStore: { available: true, read: async () => ({ intervalMin: 60, topN: 15, keepEvents: 500 }), patch: async (f) => ({ intervalMin: 60, topN: 15, keepEvents: 500, ...f }) },
    logger: { warn() {} },
    now: () => 1790700005000,
    ...extra,
  };
}

function req(method, path, { ip = '127.0.0.1', headers = {}, socket = true } = {}) {
  const r = { method, url: new URL(`http://127.0.0.1${ROUTE_PREFIX}${path}`), headers };
  if (socket) r.socket = { remoteAddress: ip };
  return r;
}

check('api-01 GET /api/snapshot 全量形状（spec §8 字段表逐项在场）', async () => {
  const deps = depsStub();
  const res = makeRes();
  const handler = createApiHandler(deps);
  await handler(req('GET', '/api/snapshot'), res);
  const body = res.json();
  assert.equal(body.ok, true);
  const d = body.data;
  for (const k of ['at', 'caps', 'capabilityRows', 'prefs', 'storage', 'sources', 'models', 'top', 'free', 'events']) {
    assert.ok(k in d, `快照缺字段 ${k}`);
  }
  assert.equal(d.models.count, 3);
  assert.equal(d.top.rows.length, 15, 'top 按 prefs.topN 截取');
  assert.equal(d.sources.rankings.unofficial, true, '非官方标注必须随快照出门');
  assert.equal(d.sources.free.unofficial, true, '免费榜也是非官方源，标注随行');
  assert.equal(d.sources.free.ok, true);
});

check('api-02 快照的 newThisWeek 由宿主现算（7 天窗），界面拿不到判定口径', async () => {
  const deps = depsStub();
  const snap = await snapshotOf(deps);
  assert.deepEqual(snap.models.newThisWeek.map((r) => r.id), ['a/x']);
});

check('api-03 还没跑过第一轮：sources 说「还没跑过」而不是冒充故障', async () => {
  const deps = depsStub({ stateStore: { available: true, read: async () => null } });
  const snap = await snapshotOf(deps);
  assert.equal(snap.sources.models.ok, false);
  assert.match(snap.sources.models.error, /还没跑过/);
  assert.equal(snap.models.count, 0);
});

check('api-04 读旧档抛（无存储）：storage.available=false 且原因说存储', async () => {
  const deps = depsStub({ stateStore: { available: false, read: async () => { throw new Error('UNAVAILABLE'); } }, eventStore: { available: false, list: async () => { throw new Error('x'); } } });
  const snap = await snapshotOf(deps);
  assert.equal(snap.storage.available, false);
  assert.match(snap.sources.models.error, /存储/);
});

check('api-05 GET /api/stream 首帧是 snapshot，保持长连接不 end', async () => {
  const deps = depsStub();
  const res = makeRes();
  const handler = createApiHandler(deps);
  await handler(req('GET', '/api/stream'), res);
  assert.ok(res.writes.some((w) => w.startsWith('event: snapshot\ndata: ')), '首帧必须是 snapshot');
  assert.equal(res.ended, false, 'SSE 不能提前 end');
});

check('api-06 POST /api/check 走 check.run 并透传结果', async () => {
  let called = 0;
  const deps = depsStub({ check: { run: async (o) => { called += 1; return { at: 42, produced: { new_model: 1 }, trigger: o?.trigger }; } } });
  const res = makeRes();
  await createApiHandler(deps)(req('POST', '/api/check'), res);
  assert.equal(called, 1);
  assert.equal(res.json().data.at, 42);
});

check('api-07 CHECK_BUSY 翻译为 409 而不是 500', async () => {
  const deps = depsStub({ check: { run: () => { throw Object.assign(new Error('跑着呢'), { code: 'CHECK_BUSY' }); } } });
  const res = makeRes();
  await createApiHandler(deps)(req('POST', '/api/check'), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'CHECK_BUSY');
});

check('api-08 未知路由 404；方法不匹配 405 且列出允许方法', async () => {
  const handler = createApiHandler(depsStub());
  const r1 = makeRes();
  await handler(req('GET', '/api/nope'), r1);
  assert.equal(r1.statusCode, 404);
  const r2 = makeRes();
  await handler(req('GET', '/api/check'), r2);
  assert.equal(r2.statusCode, 405);
  assert.match(r2.json().error.message, /POST/);
});

check('api-09 非回环 POST 一律 403，GET 不受闸（写操作口径，见文件头）', async () => {
  const handler = createApiHandler(depsStub());
  const res = makeRes();
  await handler(req('POST', '/api/check', { ip: '10.0.0.5' }), res);
  assert.equal(res.statusCode, 403);
  const res2 = makeRes();
  await handler(req('GET', '/api/snapshot', { ip: '10.0.0.5' }), res2);
  assert.equal(res2.statusCode, 200);
});

check('api-10 x-forwarded-for 有一跳非回环就拒（反代驱动写操作）', async () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '127.0.0.1, 8.8.8.8' } }), false);
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '127.0.0.1, ::1' } }), true);
});

check('api-11 POST /api/prefs 只认三键、脏键丢弃，并回调 onPrefsChanged', async () => {
  let changed = 0;
  let patched = null;
  const deps = depsStub({
    onPrefsChanged: () => { changed += 1; },
    prefsStore: { available: true, read: async () => ({}), patch: async (f) => { patched = f; return { intervalMin: 60, topN: 15, keepEvents: 500 }; } },
  });
  const res = makeRes();
  await createApiHandler(deps)(req('POST', '/api/prefs'), res, { intervalMin: 60, evil: 'x', topN: '12' });
  assert.deepEqual(patched, { intervalMin: 60, topN: '12' }, '未登记键不许进 patch');
  assert.equal(changed, 1);
  assert.equal(res.json().data.intervalMin, 60);
});

check('api-12 GET /api/events 的 limit 钳制：0/负/脏值回落 100，上限 500', async () => {
  let asked = null;
  const deps = depsStub({ eventStore: { available: true, list: async (n) => { asked = n; return []; } } });
  const handler = createApiHandler(deps);
  for (const [q, want] of [['', 100], ['0', 100], ['-5', 100], ['abc', 100], ['9999', 500], ['7', 7]]) {
    const res = makeRes();
    const r = req('GET', `/api/events?limit=${q}`);
    await handler(r, res);
    assert.equal(asked, want, `limit=${JSON.stringify(q)} 应为 ${want}，实为 ${asked}`);
  }
});

check('api-13 带 code 的错误绝不落回 200：未登记 code 走 500', async () => {
  assert.equal(statusFor('MODELWATCH_RECORDS_UNAVAILABLE'), 501);
  assert.equal(statusFor('MODELWATCH_RECORDS_INVALID'), 400);
  assert.equal(statusFor('WHO_KNOWS'), 500);
});

check('api-14 openSse：开流即写 : ok，send 写完整帧，close 幂等', async () => {
  const res = makeRes();
  const sse = openSse(res, {});
  assert.ok(res.writes.includes(': ok\n\n'));
  sse.send('update', { a: 1 });
  assert.ok(res.writes.some((w) => w === 'event: update\ndata: {"a":1}\n\n'));
  sse.close();
  sse.close();
  const before = res.writes.length;
  sse.send('update', { a: 2 });
  assert.equal(res.writes.length, before, 'close 后不再发帧');
});

check('api-15 openSse 心跳写失败当场走 onBroken（不留僵尸订阅）', async () => {
  const timers = {};
  const res = {
    writeHead() {},
    write(chunk) { if (String(chunk).includes('ping')) throw new Error('broken pipe'); },
  };
  let broken = 0;
  const sse = openSse(res, {
    onBroken: () => { broken += 1; },
    setIntervalMod: (fn) => { timers.fn = fn; return { unref() {} }; },
    clearIntervalMod: () => { timers.cleared = true; },
  });
  void sse;
  timers.fn();
  assert.equal(broken, 1);
  assert.equal(timers.cleared, true);
});

check('api-16 心跳默认 25s 且与 sysops 同值（帧语义同源）', () => {
  assert.equal(SSE_HEARTBEAT_MS, 25000);
});

check('api-17 hub.broadcast 写炸的连接当场摘牌', async () => {
  const { createHub } = await import('../lib/api.js');
  const hub = createHub();
  let sends = 0;
  const good = { send: () => { sends += 1; } };
  const bad = { send: () => { throw new Error('gone'); }, close: () => {} };
  hub.add(good);
  hub.add(bad);
  hub.broadcast('update', {});
  assert.equal(hub.count, 1);
  assert.equal(sends, 1);
});

check('api-18 subscribeEvent 把 check 的 update 帧汇进 hub（载荷=全量快照同形）', async () => {
  let emitFn = null;
  const deps = depsStub({ subscribeEvent: (fn) => { emitFn = fn; return () => {}; } });
  const handler = createApiHandler(deps);
  const res = makeRes();
  await handler(req('GET', '/api/stream'), res);
  res.writes.length = 0;
  emitFn({ type: 'update', produced: {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(res.writes.some((w) => w.startsWith('event: update\ndata: ')), 'update 帧要能广播到在连的 SSE');
});

check('api-20 update 帧载荷 = GET snapshot 同形全量（浏览器合并时不许凭空补字段）', async () => {
  let emitFn = null;
  const deps = depsStub({ subscribeEvent: (fn) => { emitFn = fn; return () => {}; } });
  const handler = createApiHandler(deps);
  const res = makeRes();
  await handler(req('GET', '/api/stream'), res);
  res.writes.length = 0;
  emitFn({ type: 'update', produced: {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const frame = res.writes.find((w) => w.startsWith('event: update\ndata: '));
  assert.ok(frame, 'update 帧要广播到在连的 SSE');
  const data = JSON.parse(frame.slice('event: update\ndata: '.length).trim());
  for (const k of ['at', 'caps', 'capabilityRows', 'prefs', 'storage', 'sources', 'models', 'top', 'free', 'events']) {
    assert.ok(k in data, `update 帧缺快照字段 ${k}：界面合并时就得替宿主编数据`);
  }
});

check('api-21 快照 free：行按 prefs.topN 切片、来源注吃宿主单点文案、旧档无 freeTop 时给空数组', async () => {
  const snap = await snapshotOf(depsStub());
  assert.equal(snap.free.rows.length, 3);
  assert.match(snap.free.note, /非官方/);
  assert.match(snap.free.note, /免费/);
  assert.equal(snap.sources.free.note, snap.free.note, '来源注单点：源行与榜面必须同一句');
  const narrow = await snapshotOf(depsStub({ prefsStore: { available: true, read: async () => ({ intervalMin: 60, topN: 2, keepEvents: 500 }) } }));
  assert.equal(narrow.free.rows.length, 2, '免费榜同受「榜单条数」偏好约束');
  const legacy = await snapshotOf(depsStub({
    stateStore: { available: true, read: async () => ({ at: 1, modelCount: 1, modelIds: ['a/x'], newRecent: [], top: [], prevTop: [], modelsOk: true, rankOk: true }) },
  }));
  assert.deepEqual(legacy.free.rows, [], '免费榜上线前的旧档：读得出、free 给空数组而不是缺字段');
  assert.equal(legacy.sources.free.ok, false, '旧档没有 freeOk：如实说没跑过，不冒充在位');
  assert.match(legacy.sources.free.error, /还没跑过/);
});

check('api-19 GLOBAL_KEY / ROUTE_PREFIX 是双侧约定，值钉死', () => {
  assert.equal(ROUTE_PREFIX, '/modelwatch');
  assert.equal(GLOBAL_KEY, '__MODELWATCH__');
  assert.ok('GET /api/snapshot' in ROUTES && 'POST /api/check' in ROUTES);
});

await runAll('api');
