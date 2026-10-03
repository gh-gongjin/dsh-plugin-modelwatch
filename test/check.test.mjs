import { check, runAll, assert } from './_helpers.mjs';
import { createCheckService } from '../lib/check.js';

const PREFS = { intervalMin: 60, topN: 15, keepEvents: 500 };

function memStores({ initialState = null } = {}) {
  let state = initialState;
  const events = [];
  const trims = [];
  return {
    events,
    trims,
    getState: () => state,
    stateStore: {
      available: true,
      read: async () => state,
      write: async (row) => { state = { ...row, modelIds: [...row.modelIds], top: row.top.map((r) => ({ ...r })) }; return state; },
      close: async () => {},
    },
    eventStore: {
      available: true,
      append: async (e) => { events.push({ ...e }); return e; },
      list: async () => [...events].reverse(),
      trim: async (keep) => { trims.push(keep); return 0; },
      close: async () => {},
    },
  };
}

/** 按调用顺序吐出预置结果；用完后重复最后一个（方便只关心前两轮的用例）。 */
function scripter(list) {
  let i = 0;
  return async () => {
    const r = list[Math.min(i, list.length - 1)];
    i += 1;
    return typeof r === 'function' ? r() : r;
  };
}
const modelsOk = (ids, nameOf = (id) => `N:${id}`) => ({
  ok: true,
  rows: ids.map((id, k) => ({ id, name: nameOf(id), created: 1790700000 + k })),
});
const rankOk = (slugs) => ({
  ok: true,
  view: 'week',
  rows: slugs.map((slug, k) => ({ slug, tokens: 1000 - k })),
});
// v1.8：免费榜是独立源，走自己的 fetchFn（rows 已由宿主排好序）
const freeOk = (slugs) => ({
  ok: true,
  rows: slugs.map((slug, k) => ({ slug, tokens: 500 - k })),
});
const modelsBad = (error) => ({ ok: false, error });
const rankBad = (reason) => ({ ok: false, reason });
const freeBad = (reason) => ({ ok: false, reason });

function makeCheck({ stores, m, r, f, getIntervalFn, nowStart = 1790700000000, onEvent = null, logger = null }) {
  let t = nowStart;
  return createCheckService({
    getPrefs: () => PREFS,
    stateStore: stores.stateStore,
    eventStore: stores.eventStore,
    logger,
    now: () => (t += 1000),
    getIntervalFn: getIntervalFn ?? (() => undefined),
    fetchModelsFn: scripter(m ?? [modelsOk(['a/x'])]),
    fetchRankingsFn: scripter(r ?? [rankOk(['a/x'])]),
    fetchFreeRankingsFn: scripter(f ?? [freeOk([])]),
    onEvent,
  });
}

check('check-01 首轮：只产 baseline，不产 diff 事件，state 落 baseline 标记', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores, m: [modelsOk(['a/x', 'b/y'])], r: [rankOk(['a/x', 'b/y'])] });
  const res = await svc.run();
  assert.equal(res.firstRun, true);
  assert.equal(stores.events.length, 1);
  assert.equal(stores.events[0].kind, 'baseline');
  assert.equal(stores.getState().modelCount, 2);
  assert.equal(stores.getState().baseline, true);
  assert.equal(res.produced.new_model, 0);
});

check('check-02 第二轮：上下架各产一条，detail 带模型名', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['a/x', 'b/y', 'c/z']), modelsOk(['a/x', 'c/z', 'd/w'])],
    r: [rankOk(['a/x']), rankOk(['a/x'])] });
  await svc.run();
  await svc.run();
  const kinds = stores.events.map((e) => `${e.kind}:${e.slug}`);
  assert.ok(kinds.includes('new_model:d/w'), kinds.join(','));
  assert.ok(kinds.includes('removed_model:b/y'), kinds.join(','));
  const added = stores.events.find((e) => e.kind === 'new_model');
  assert.equal(added.detail, 'N:d/w');
});

check('check-03 榜单第二轮：进/出/挪位≥3 各记一条，挪 2 不算（噪声闸）', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['m1', 'm2', 'm3', 'm4', 'm5']), modelsOk(['m1', 'm2', 'm3', 'm4', 'm5'])],
    r: [rankOk(['m1', 'm2', 'm3', 'm4', 'm5']), rankOk(['m1', 'm3', 'm4', 'm2', 'm5'])] });
  // 第一轮后手动把 prev 的 rank 拉开：m2 第 2→第 4（挪 2，不记）；m3 第 3→第 2（挪 1，不记）
  await svc.run();
  stores.events.length = 0;
  await svc.run();
  const kinds = stores.events.map((e) => e.kind);
  assert.ok(!kinds.includes('top_enter') && !kinds.includes('top_exit'), '集合没变不该有进出');
  assert.ok(!kinds.includes('top_move'), `挪 1/2 都超不过噪声闸：${kinds.join(',')}`);

  const stores2 = memStores();
  const svc2 = makeCheck({ stores: stores2,
    m: [modelsOk(['m1', 'm2', 'm3', 'm4', 'm5']), modelsOk(['m1', 'm2', 'm3', 'm4', 'm5'])],
    r: [rankOk(['m1', 'm2', 'm3', 'm4', 'm5']), rankOk(['m5', 'm1', 'm2', 'm3', 'm4'])] });
  await svc2.run();
  stores2.events.length = 0;
  await svc2.run();
  const move = stores2.events.filter((e) => e.kind === 'top_move');
  assert.ok(move.some((e) => e.slug === 'm5' && e.detail === '5 → 1'), JSON.stringify(move));
  assert.ok(!move.some((e) => e.slug === 'm1'), 'm1 从 1→2 挪 1，不该记');
});

check('check-04 榜单进/出榜：各一条且方向正确', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['x', 'y', 'z']), modelsOk(['x', 'y', 'z', 'w'])],
    r: [rankOk(['x', 'y', 'z']), rankOk(['x', 'y', 'w'])] });
  await svc.run();
  stores.events.length = 0;
  await svc.run();
  const kinds = stores.events.map((e) => `${e.kind}:${e.slug}`);
  assert.ok(kinds.includes('top_enter:w'), kinds.join(','));
  assert.ok(kinds.includes('top_exit:z'), kinds.join(','));
});

check('check-05 源故障只记翻转：连坏两轮记一条，恢复再记一条', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['a']), modelsBad('清单源返回 503'), modelsBad('清单源返回 503'), modelsOk(['a'])],
    r: [rankOk(['a']), rankOk(['a']), rankOk(['a']), rankOk(['a'])] });
  await svc.run(); // baseline
  stores.events.length = 0;
  await svc.run(); // 坏 1 → source_error
  const errsAfterFirst = stores.events.filter((e) => e.kind === 'source_error').length;
  assert.equal(errsAfterFirst, 1);
  await svc.run(); // 坏 2 → 不重复记
  assert.equal(stores.events.filter((e) => e.kind === 'source_error').length, 1, '连坏不刷屏');
  await svc.run(); // 恢复 → source_recover
  assert.equal(stores.events.filter((e) => e.kind === 'source_recover').length, 1);
  // 故障轮 state 仍写：modelsOk=false + 原因，模型计数保留旧档
  const st = stores.getState();
  assert.equal(st.modelsOk, true, '最后一轮已恢复');
});

check('check-06 首轮就坏：记 source_error 且 modelsOk=false 落进 state', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores, m: [modelsBad('清单源请求失败：boom')], r: [rankBad('页面结构变化')] });
  const res = await svc.run();
  assert.equal(res.modelsOk, false);
  assert.equal(res.rankOk, false);
  const st = stores.getState();
  assert.equal(st.modelsOk, false);
  assert.match(st.modelsError, /boom/);
  assert.match(st.rankError, /结构变化/);
  assert.ok(stores.events.some((e) => e.kind === 'source_error'));
});

check('check-07 清单坏不拦榜单：好的一侧照常更新与记账', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['a']), modelsBad('503')],
    r: [rankOk(['a']), rankOk(['a', 'b'])] });
  await svc.run();
  stores.events.length = 0;
  const res = await svc.run();
  assert.equal(res.rankOk, true);
  const kinds = stores.events.map((e) => `${e.kind}:${e.slug || ''}`);
  assert.ok(kinds.includes('top_enter:b'), kinds.join(','));
  assert.ok(kinds.some((k) => k.startsWith('source_error')), `坏的一侧也要如实落一笔：${kinds.join(',')}`);
});

check('check-08 无存储：read 抛 → 不落库不崩，本轮判定照常算完', async () => {
  const stores = memStores();
  stores.stateStore.read = async () => { throw Object.assign(new Error('无域'), { code: 'X' }); };
  let wrote = false;
  stores.stateStore.write = async () => { wrote = true; };
  const warns = [];
  const svc = makeCheck({ stores, logger: { warn: (m) => warns.push(m) } });
  const res = await svc.run();
  assert.equal(res.modelsOk, true);
  assert.equal(wrote, false, '读旧档失败时绝不覆盖写新档（会把老基线抹平）');
  assert.ok(warns.length > 0, '留痕不许静默');
});

check('check-09 busy 单闸：跑中再触发抛 CHECK_BUSY，结束后闸重新放开', async () => {
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const stores = memStores();
  const svc = createCheckService({
    getPrefs: () => PREFS,
    stateStore: stores.stateStore,
    eventStore: stores.eventStore,
    now: () => 1790700000000,
    getIntervalFn: () => undefined,
    fetchModelsFn: async () => { await gate; return modelsOk(['a']); },
    fetchRankingsFn: async () => rankOk(['a']),
    fetchFreeRankingsFn: async () => freeOk([]),
  });
  const p = svc.run();
  assert.equal(svc.running, true);
  // 必须是 rejected promise 而不是同步 throw：定时器回调接不住同步异常，会打崩宿主。
  const second = svc.run();
  // 先放闸再收尾断言：闸要是被变异摘掉，第二轮会等 gate 等到天荒地老（互等死锁，套件连 FAIL 都吐不出）。
  release();
  await assert.rejects(second, (e) => e.code === 'CHECK_BUSY');
  await p;
  assert.equal(svc.running, false);
  await svc.run(); // 闸放开
});

check('check-10 每轮以 update 帧收尾，载荷带 produced', async () => {
  const stores = memStores();
  const frames = [];
  const svc = makeCheck({ stores, onEvent: (ev) => frames.push(ev) });
  await svc.run({ trigger: 'manual' });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'update');
  assert.equal(frames[0].trigger, 'manual');
  assert.ok(frames[0].produced);
});

check('check-11 事件落库炸（如无存储）：一轮检查不中断，只留痕', async () => {
  const stores = memStores();
  stores.eventStore.append = async () => { throw new Error('CLOSED'); };
  const warns = [];
  const svc = makeCheck({ stores, logger: { warn: (m) => warns.push(m) }, m: [modelsOk(['a'])] });
  const res = await svc.run();
  assert.equal(res.at > 0, true);
  assert.ok(warns.some((w) => w.includes('事件落库失败')));
});

check('check-12 每轮落库后按 prefs.keepEvents 裁剪流水', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores });
  await svc.run();
  assert.deepEqual(stores.trims, [500]);
});

check('check-13 定时节拍：宿主 timer 优先，缺了退 setInterval（unref），dispose 清干净', async () => {
  const stores = memStores();
  let hostCalls = 0;
  let disposed = 0;
  // 真宿主 ctx.timer.interval 返回 disposer 函数，不是 handle —— 停表必须调它。
  const svc = makeCheck({ stores, getIntervalFn: () => ((fn, ms) => { hostCalls += 1; const h = { fn, ms, unref() {} }; const d = () => { disposed += 1; }; d.handle = h; return d; }) });
  svc.setCadence(360);
  assert.equal(hostCalls, 1);
  assert.equal(svc.timerBackend, 'ctx.timer');
  svc.setCadence(60); // 重挂：旧的必须停掉
  assert.equal(hostCalls, 2);
  svc.dispose();
  assert.equal(disposed, 2, '两次重挂/dispose 都要停掉旧定时器（clearInterval 对函数句柄是 no-op → 泄漏）');
});

check('check-14 无宿主 timer 时 timerBackend 说 setInterval（能力位不许自相矛盾）', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores }); // getIntervalFn → undefined
  svc.setCadence(60);
  assert.equal(svc.timerBackend, 'setInterval');
  svc.dispose();
  assert.equal(svc.timerBackend, 'setInterval');
});

check('check-15 top 行 delta：升为正、降为负、新入榜不补 0（S17：不凭空造字段）', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['p', 'q', 'r', 's', 't']), modelsOk(['p', 'q', 'r', 's', 't'])],
    r: [rankOk(['p', 'q', 'r', 's', 't']), rankOk(['q', 'p', 'r', 's', 't'])] });
  await svc.run();
  await svc.run();
  const top = stores.getState().top;
  const q = top.find((x) => x.slug === 'q');
  const p = top.find((x) => x.slug === 'p');
  assert.equal(q.delta, 1, 'q 从 2→1 是升');
  assert.equal(p.delta, -1, 'p 从 1→2 是降');
  const r = top.find((x) => x.slug === 'r');
  assert.equal(r.delta, undefined, '没动的行不许带 delta 字段');
});

check('check-16 首轮榜单无对比基准：top 行一律不带 delta', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores, m: [modelsOk(['a', 'b'])], r: [rankOk(['a', 'b'])] });
  await svc.run();
  assert.ok(stores.getState().top.every((r) => !('delta' in r)));
});

check('check-17 榜单坏转好：只记 source_recover，不补产积压进/出/挪位（拿不到公允上轮就不记账）', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['a', 'b']), modelsOk(['a', 'b']), modelsOk(['a', 'b'])],
    r: [rankOk(['a', 'b']), rankBad('页面结构变化：没找到 flight 数据段'), rankOk(['b', 'a', 'c'])] });
  await svc.run(); // baseline：top=[a,b]，rankOk=true
  stores.events.length = 0;
  await svc.run(); // 榜单坏 → source_error
  await svc.run(); // 恢复且榜单变了：c 进榜、a/b 换位 —— 都不许补产
  const kinds = stores.events.map((e) => e.kind);
  assert.ok(kinds.includes('source_recover'), `恢复必须记一条：${kinds.join(',')}`);
  assert.ok(!kinds.includes('top_enter') && !kinds.includes('top_exit') && !kinds.includes('top_move'),
    `坏转好那轮不许补产积压账：${kinds.join(',')}`);
});

check('check-18 免费榜 delta 独立成榜：名次按免费榜自己的行排，且不产任何流水事件', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['a/x']), modelsOk(['a/x'])],
    r: [rankOk(['a/x']), rankOk(['a/x'])],
    f: [freeOk(['f/p:free', 'f/q:free']), freeOk(['f/q:free', 'f/p:free'])] });
  await svc.run();
  const first = stores.getState().freeTop;
  assert.deepEqual(first.map((r) => `${r.rank}:${r.slug}`), ['1:f/p:free', '2:f/q:free'], '首轮名次按行顺序');
  assert.ok(first.every((r) => !('delta' in r)), '首轮无对比基准不许带 delta');
  stores.events.length = 0;
  await svc.run();
  const st = stores.getState();
  assert.equal(st.freeTop[0].slug, 'f/q:free');
  assert.equal(st.freeTop[0].delta, 1, 'f/q 从 2→1：升为正');
  assert.equal(st.freeTop[1].delta, -1, 'f/p 从 1→2：降为负');
  assert.deepEqual(st.prevFreeTop, ['f/p:free', 'f/q:free']);
  assert.equal(stores.events.length, 0, '免费榜进出/挪位都不进流水（周榜独享事件口径）');
});

check('check-19 免费榜坏轮：freeTop 与 prevFreeTop 冻结在最后一次成功轮，不被清空', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['a']), modelsOk(['a']), modelsOk(['a'])],
    r: [rankOk(['a']), rankOk(['a', 'b']), rankOk(['a', 'b'])],
    f: [freeOk(['f/p:free']), freeBad('免费榜源返回 503'), freeBad('免费榜源仍坏')] });
  await svc.run(); // 成功轮：freeTop=[f/p], prevFreeTop=[]（首轮无上一榜）
  await svc.run(); // 免费榜坏：冻结；周榜侧照常更新（b 进榜记 top_enter）
  await svc.run(); // 连坏：仍然冻结，不许逐轮自我清空
  const st = stores.getState();
  assert.equal(st.rankOk, true, '周榜侧不受免费榜坏的影响');
  assert.equal(st.freeOk, false);
  assert.match(st.freeError, /仍坏/, 'freeError 记的是最新一轮的原因');
  assert.deepEqual(st.freeTop.map((r) => r.slug), ['f/p:free'], '坏轮快照里免费榜仍显示上次成功数据');
  assert.deepEqual(st.prevFreeTop, [], 'prevFreeTop 冻结在最后一次成功轮');
  assert.deepEqual(st.top.map((r) => r.slug), ['a', 'b']);
  const kinds = stores.events.map((e) => `${e.kind}`);
  assert.equal(kinds.filter((k) => k === 'source_error').length, 1, '免费榜连坏两轮只记一笔');
});

check('check-20 三源独立：周榜坏不拦免费榜，免费榜翻转各记各的账', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['a']), modelsOk(['a']), modelsOk(['a'])],
    r: [rankOk(['a']), rankBad('页面结构变化'), rankOk(['a'])],
    f: [freeOk(['f/x:free']), freeOk(['f/x:free', 'f/y:free']), freeOk(['f/x:free', 'f/y:free'])] });
  await svc.run(); // baseline
  stores.events.length = 0;
  const r2 = await svc.run(); // 周榜坏、免费榜好
  assert.equal(r2.rankOk, false);
  assert.equal(r2.freeOk, true);
  const st2 = stores.getState();
  assert.deepEqual(st2.freeTop.map((r) => r.slug), ['f/x:free', 'f/y:free'], '免费榜照常推进');
  assert.deepEqual(st2.prevFreeTop, ['f/x:free']);
  const kinds2 = stores.events.map((e) => e.kind);
  assert.ok(kinds2.includes('source_error'), '周榜坏记一笔');
  assert.ok(!kinds2.some((k) => k === 'source_recover'), '免费榜没坏过不该记恢复');
  stores.events.length = 0;
  await svc.run(); // 周榜恢复
  const kinds3 = stores.events.map((e) => e.kind);
  assert.ok(kinds3.includes('source_recover'), '周榜坏转好记恢复');
  assert.equal(kinds3.filter((k) => k === 'source_error').length, 0, '免费榜持续好，不该冒出错误账');
});

check('check-21 免费榜坏转好：只记 source_recover，不补产积压 delta；恢复轮名次重排不带私账', async () => {
  const stores = memStores();
  const svc = makeCheck({ stores,
    m: [modelsOk(['a']), modelsOk(['a']), modelsOk(['a'])],
    r: [rankOk(['a']), rankOk(['a']), rankOk(['a'])],
    f: [freeOk(['f/x:free', 'f/y:free']), freeBad('免费榜源返回 503'), freeOk(['f/y:free', 'f/x:free'])] });
  await svc.run(); // 首轮：freeTop=[x,y]，freeOk=true
  stores.events.length = 0;
  await svc.run(); // 坏轮：source_error 一笔，freeTop 冻结
  assert.equal(stores.events.filter((e) => e.kind === 'source_error').length, 1);
  stores.events.length = 0;
  await svc.run(); // 好转好：y/x 顺序反了，但不许补产 delta（上轮不公允）
  const st = stores.getState();
  assert.deepEqual(st.freeTop.map((r) => r.slug), ['f/y:free', 'f/x:free']);
  assert.ok(st.freeTop.every((r) => !('delta' in r)), '坏转好那轮拿不到公允上轮，名次重排也不记账');
  const kinds = stores.events.map((e) => `${e.kind}:${e.detail}`);
  assert.ok(kinds.some((k) => k.includes('免费周榜源恢复')), kinds.join(','));
  assert.equal(kinds.filter((k) => k.startsWith('source_error')).length, 0);
});

await runAll('check');
