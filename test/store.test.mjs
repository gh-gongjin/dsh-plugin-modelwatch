import { check, runAll, assert, makeFakeFacility } from './_helpers.mjs';
import { createStateStore, createEventStore, createPrefsStore } from '../lib/stores.js';
import { RECORDS_ERROR } from '../lib/kv-records-base.js';
import { DEFAULT_PREFS, CHECK_INTERVALS } from '../lib/domain.js';

const NOW_BASE = 1790700000000;
function makeStores({ clock = NOW_BASE } = {}) {
  const facility = makeFakeFacility();
  let t = clock;
  const now = () => (t += 1);
  const getFacility = () => facility;
  const warns = [];
  const logger = { warn: (m) => warns.push(m) };
  return {
    facility, warns, now,
    state: createStateStore({ getFacility, logger }),
    events: createEventStore({ getFacility, logger, now }),
    prefs: createPrefsStore({ getFacility, logger }),
  };
}

const STATE_ROW = {
  at: 1790700000000, modelCount: 2, modelIds: ['a/x', 'b/y'], newRecent: [],
  top: [{ rank: 1, slug: 'a/x', tokens: 10 }], prevTop: [],
  baseline: true, modelsOk: true, rankOk: true,
};

check('store-01 state 首轮读到 null，写入后原样往返', async () => {
  const s = makeStores();
  assert.equal(await s.state.read(), null);
  const w = await s.state.write(STATE_ROW);
  assert.equal(w.modelCount, 2);
  const back = await s.state.read();
  assert.equal(back.at, STATE_ROW.at);
  assert.deepEqual(back.modelIds, ['a/x', 'b/y']);
});

check('store-02 state 脏行（缺 modelCount）被 schema 挡在 put 之前，带 code INVALID', async () => {
  const s = makeStores();
  const bad = { ...STATE_ROW };
  delete bad.modelCount;
  await assert.rejects(s.state.write(bad), (e) => e.code === RECORDS_ERROR.INVALID);
});

check('store-03 state 未声明字段被丢弃而不是默默存下', async () => {
  const s = makeStores();
  const w = await s.state.write({ ...STATE_ROW, smuggled: 'x' });
  assert.equal(w.smuggled, undefined);
});

check('store-04 events 同毫秒连发 id 不重号（宿主发号带序号）', async () => {
  const s = makeStores();
  let t = 0;
  const events = createEventStore({ getFacility: () => s.facility, now: () => 1790700000000, logger: { warn() {} } });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await events.append({ kind: 'new_model', slug: `m${i}` })).id);
  assert.equal(new Set(ids).size, 3, `id 撞号：${ids.join(',')}`);
  void t;
});

check('store-05 events list 按 at 降序、limit 生效且钳在 1..500', async () => {
  const s = makeStores();
  for (let i = 0; i < 5; i++) await s.events.append({ kind: 'new_model', slug: `m${i}` });
  const all = await s.events.list(100);
  assert.equal(all.length, 5);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].at >= all[i].at);
  assert.equal((await s.events.list(2)).length, 2);
  assert.equal((await s.events.list(0)).length, 5, 'limit 0 当「没填」→ 默认 100，不是把列表裁空');
  assert.equal((await s.events.list(9999)).length, 5, 'limit 超 500 钳到 500（数据不足 5 条仍 5）');
});

check('store-06 events trim 只裁最老的，keep 非法时不动刀', async () => {
  const s = makeStores();
  for (let i = 0; i < 6; i++) await s.events.append({ kind: 'new_model', slug: `m${i}` });
  const doomed = await s.events.trim(4);
  assert.equal(doomed, 2);
  assert.equal((await s.events.list(100)).length, 4);
  assert.equal(await s.events.trim(0), 0);
  assert.equal(await s.events.trim('abc'), 0);
  assert.equal((await s.events.list(100)).length, 4, '非法 keep 没把流水裁空');
});

check('store-07 prefs 空库读回默认值', async () => {
  const s = makeStores();
  assert.equal(DEFAULT_PREFS.intervalMin, 60, '出厂默认 1 小时（写死，防默认值悄悄漂移）');
  assert.ok(CHECK_INTERVALS.includes(DEFAULT_PREFS.intervalMin),
    '默认档位必须能在设置页分段器里选中，否则用户看到的是个改不回去的幽灵值');
  assert.deepEqual(await s.prefs.read(), DEFAULT_PREFS);
});

check('store-08 prefs patch 读-并-写：半份请求不抹掉其余键', async () => {
  const s = makeStores();
  const saved = await s.prefs.patch({ topN: 8 });
  assert.equal(saved.topN, 8);
  assert.equal(saved.intervalMin, DEFAULT_PREFS.intervalMin);
  assert.equal(saved.keepEvents, DEFAULT_PREFS.keepEvents);
  assert.deepEqual(await s.prefs.read(), saved);
});

check('store-09 prefs 钳制：脏档位回落默认，topN/keepEvents 进边界', async () => {
  const s = makeStores();
  const p1 = await s.prefs.patch({ intervalMin: 7, topN: 999 });
  assert.equal(p1.intervalMin, DEFAULT_PREFS.intervalMin, '不在封闭档位表里的 7 分钟必须回落');
  assert.equal(p1.topN, 20);
  const p2 = await s.prefs.patch({ keepEvents: -5 });
  assert.equal(p2.keepEvents, 50);
});

check('store-10 无设施：available=false，state 抛 UNAVAILABLE，prefs 静默回默认', async () => {
  const getFacility = () => undefined;
  const state = createStateStore({ getFacility, logger: { warn() {} } });
  const prefs = createPrefsStore({ getFacility, logger: { warn() {} } });
  assert.equal(state.available, false);
  await assert.rejects(state.read(), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
  assert.deepEqual(await prefs.read(), DEFAULT_PREFS, '读偏好不能因为没存储而卡死界面首帧');
});

check('store-11 三仓储同域：facility.open 只发生一次（already-open 事故回归）', async () => {
  const s = makeStores();
  await s.state.read().catch(() => {});
  await s.events.list(10).catch(() => {});
  await s.prefs.read();
  assert.equal(s.facility.calls.open, 1, `open 被调了 ${s.facility.calls.open} 次`);
});

check('store-12 close 后写入报 CLOSED；域只在最后一个持有者放手时才真关', async () => {
  const s = makeStores();
  await s.state.write(STATE_ROW);
  await s.events.append({ kind: 'new_model', slug: 'a' });
  await s.state.close();
  await assert.rejects(s.state.write(STATE_ROW), (e) => e.code === RECORDS_ERROR.CLOSED);
  assert.equal(s.facility.calls.close, 0, 'events 还持有域，不能提前关');
  await s.events.close();
  await s.prefs.close();
  assert.equal(s.facility.calls.close, 1);
});

check('store-13 域关掉后重新取：走 closingDone 重开而不是撞 already-open', async () => {
  const s = makeStores();
  await s.state.read().catch(() => {});
  await s.state.close();
  await s.events.close();
  await s.prefs.close();
  assert.equal(s.facility.calls.close, 1);
  const st2 = createStateStore({ getFacility: () => s.facility, logger: { warn() {} } });
  await st2.write(STATE_ROW);
  assert.equal(s.facility.calls.open, 2);
  await st2.close();
});

check('store-14 事件 kind 越界值挡在落库前（INVALID 而不是脏进库）', async () => {
  const s = makeStores();
  await assert.rejects(s.events.append({ kind: 'model_exploded', slug: 'x' }), (e) => e.code === RECORDS_ERROR.INVALID || e.message);
});

check('store-15 patch 不许把库里已存的非默认值抹回默认（读-并-写的真回归）', async () => {
  const s = makeStores();
  await s.prefs.patch({ intervalMin: 60 });
  const saved = await s.prefs.patch({ topN: 8 });
  assert.equal(saved.intervalMin, 60, '第二次只发 topN，库里的 intervalMin 必须原样还在');
  assert.equal(saved.topN, 8);
});

await runAll('store');
