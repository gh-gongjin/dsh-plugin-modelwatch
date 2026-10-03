import fs from 'node:fs';
import vm from 'node:vm';
import { check, runAll, assert } from './_helpers.mjs';

/** 在沙箱里求值 client.js，返回其 __test 出口与 apply；每次调用都是干净的 moduleLoader。
 *  opts.tab / opts.snap：把 ModelwatchPage 的页签初始值与快照初始值顶成指定值
 *  （useState('overview') / useState(null) 各只有一处，用来越过 effect 直接测 tab→组件路由）。 */
function loadClient(payload = {}, opts = {}) {
  const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const loaded = {};
  const fakeDoc = {
    getElementById: () => null,
    createElement: (tag) => ({ tag, set textContent(v) { this._t = v; }, get textContent() { return this._t; }, remove() {} }),
    head: { appendChild() {} },
  };
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (init) => {
      const v = (opts.snap !== undefined && init === null) ? opts.snap
        : (opts.tab && init === 'overview' ? opts.tab : init);
      return [v, () => {}];
    },
    useEffect: () => {},
    useRef: () => ({ current: null }),
  };
  const sandbox = {
    window: {
      __ModuleLoader__: { load: ({ factory }) => { loaded.exports = factory((name) => { if (name === 'react') return fakeReact; throw new Error(`client 要了白名单外的依赖：${name}`); }); } },
    },
    document: fakeDoc,
    fetch: async () => { throw new Error('沙箱不发真请求'); },
    setTimeout, clearTimeout, setInterval, clearInterval,
    console,
    TextDecoder: global.TextDecoder,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  // 宿主契约：ModuleLoader 吃 factory 的**返回值**当模块导出（真机事故：返回 module 外层没 apply）。
  const exports = loaded.exports;
  assert.ok(exports && typeof exports === 'object' && !('exports' in exports && typeof exports.apply !== 'function'),
    'factory 必须 return module.exports，不是 return module');
  if (Object.keys(payload).length) sandbox.__MODELWATCH__ = payload; // cfg() 现取这份载荷
  return { exports, sandbox };
}

const SNAPSHOT = {
  at: 1790700000000,
  caps: { storageDomain: true, timer: true, webServer: true },
  capabilityRows: [],
  prefs: { intervalMin: 60, topN: 15, keepEvents: 500 },
  storage: { available: true },
  sources: {
    models: { ok: true, error: undefined, checkedAt: 1790690000000, unofficial: undefined },
    rankings: { ok: false, error: '页面结构变化：没找到 flight 数据段', checkedAt: 1790690000000, unofficial: true, note: '来源：榜单页内嵌数据（非官方接口），页面改版会失效' },
    free: { ok: true, error: undefined, checkedAt: 1790690000000, unofficial: true, note: '免榜来源注' },
  },
  models: { count: 3, firstRun: false, newThisWeek: [{ id: 'a/x', name: 'A X', created: 1790699600, contextLength: 128000, priceInM: 3, priceOutM: 15 }] },
  top: { rows: [{ rank: 1, slug: 'p/m', tokens: 1.2e10 }, { rank: 2, slug: 'p/m2', tokens: 98000000 }], days: 7, note: '来源注' },
  free: { rows: [{ rank: 1, slug: 'p/m3:free', tokens: 5e6, delta: 2 }], days: 7, note: '免榜来源注' },
  events: [{ id: 'e1', at: 1790699000000, kind: 'new_model', slug: 'a/x', detail: 'A X' }],
};

/** 深度收集渲染树里所有字符串（含 props.title 之外只要可见文本）。 */
function texts(node, acc = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return acc;
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc; }
  if (Array.isArray(node)) { for (const n of node) texts(n, acc); return acc; }
  if (typeof node === 'object' && 'children' in node) { for (const c of node.children) texts(c, acc); }
  return acc;
}
function renderTree(el, props) {
  const out = el(props);
  return out;
}

/** fake react 只记 h(组件, props)，不会调用组件 —— 路由类断言要先递归展开函数组件。 */
function mount(node, depth = 0) {
  if (Array.isArray(node)) return node.map((n) => mount(n, depth));
  if (!node || typeof node !== 'object') return node;
  const kids = () => (node.children || []).map((c) => mount(c, depth + 1));
  if (typeof node.type === 'function' && depth < 16) {
    return mount(node.type({ ...(node.props || {}), children: kids() }), depth + 1);
  }
  return { ...node, children: kids() };
}
function renderPage(el, props = {}) {
  return mount(el(props));
}

/** 按 className 找节点（className 可能是 '' / 空格分隔多类）。 */
function findByClass(node, cls, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const n of node) findByClass(n, cls, acc); return acc; }
  const own = String(node.props?.className || '');
  if (own.split(/\s+/).includes(cls)) acc.push(node);
  if (Array.isArray(node.children)) { for (const c of node.children) findByClass(c, cls, acc); }
  return acc;
}

const PAYLOAD = {
  panelId: 'modelwatch', panelOrder: 14, routePrefix: '/modelwatch', api: '/modelwatch/api',
  label: '模型监控', intervals: [60, 360, 720, 1440],
  intervalLabels: { 60: '1 小时', 360: '6 小时', 720: '12 小时', 1440: '24 小时' },
  topNRange: { min: 5, max: 20 }, showDays: 7,
  eventKindLabels: { new_model: '新上模型', top_enter: '新晋周榜', source_error: '数据源故障' },
};

check('client-01 顶层零宿主依赖：factory 只要 react，其余一律抛', () => {
  const { exports } = loadClient(PAYLOAD);
  assert.equal(typeof exports.apply, 'function');
  assert.equal(exports.inject.join(','), 'slots');
});

check('client-02 载荷未到齐时 API_BASE/PANEL_ID 有硬回落（顶层快照禁止）', () => {
  const { exports } = loadClient();
  assert.equal(exports.PANEL_ID, 'modelwatch');
  assert.equal(exports.__test.API_BASE(), '/modelwatch/api');
});

check('client-03 fmtAge：刚刚/分/时/天/从未四档齐全', () => {
  const { exports } = loadClient(PAYLOAD);
  const { fmtAge } = exports.__test;
  const at = 1790700000000;
  assert.equal(fmtAge(0, at), '从未');
  assert.equal(fmtAge(at - 30000, at), '刚刚');
  assert.equal(fmtAge(at - 5 * 60000, at), '5 分钟前');
  assert.equal(fmtAge(at - 3 * 3600000, at), '3 小时前');
  assert.equal(fmtAge(at - 2 * 86400000, at), '2 天前');
});

check('client-04 fmtTokens：T/B/M/K 阶梯且计数走 1000 进制', () => {
  const { exports } = loadClient(PAYLOAD);
  const { fmtTokens } = exports.__test;
  assert.equal(fmtTokens(1.2e12), '1.20T');
  assert.equal(fmtTokens(1.2e10), '12.0B');
  assert.equal(fmtTokens(1234567800), '1.23B');
  assert.equal(fmtTokens(5e6), '5.00M');
  assert.equal(fmtTokens(1234), '1.23K');
  assert.equal(fmtTokens(12345), '12.3K');
  assert.equal(fmtTokens(900), '900');
  assert.equal(fmtTokens(undefined), '—');
});

check('client-05 fmtPrice：0 是 $0（免费），缺值是 —（两回事）', () => {
  const { exports } = loadClient(PAYLOAD);
  const { fmtPrice } = exports.__test;
  assert.equal(fmtPrice(0), '$0');
  assert.equal(fmtPrice(undefined), '—');
  assert.equal(fmtPrice(3), '$3.00');
  assert.equal(fmtPrice(125.5), '$126', '≥100 取整（四舍）');
  assert.equal(fmtPrice(0.075), '$0.075');
});

check('client-06 fmtCtx 折 K/M，脏值给 —', () => {
  const { exports } = loadClient(PAYLOAD);
  const { fmtCtx } = exports.__test;
  assert.equal(fmtCtx(128000), '128K');
  assert.equal(fmtCtx(1e6), '1.00M');
  assert.equal(fmtCtx('x'), '—');
});

check('client-07 deltaCell：▲/▼/—/新见 四态，缺字段不冒充持平', () => {
  const { exports } = loadClient(PAYLOAD);
  const { deltaCell } = exports.__test;
  // vm 里造的对象跨 realm 比不了原型，按 JSON 形状断言
  assert.equal(JSON.stringify(deltaCell(3)), JSON.stringify({ text: '▲3', cls: 'mw-up' }));
  assert.equal(JSON.stringify(deltaCell(-2)), JSON.stringify({ text: '▼2', cls: 'mw-down' }));
  assert.equal(JSON.stringify(deltaCell(0)), JSON.stringify({ text: '—', cls: 'mw-flat' }));
  assert.equal(JSON.stringify(deltaCell(undefined)), JSON.stringify({ text: '新见', cls: 'mw-flat' }));
});

check('client-08 kindLabel 查宿主表；表没到就原样显示 kind（不空屏）', () => {
  const { exports } = loadClient(PAYLOAD);
  assert.equal(exports.__test.kindLabel('new_model'), '新上模型');
  const bare = loadClient();
  assert.equal(bare.exports.__test.kindLabel('new_model'), 'new_model');
});

check('client-09 mergeFrame：snapshot/update 整体替换，绝不逐字段凭空补', () => {
  const { exports } = loadClient(PAYLOAD);
  const { mergeFrame } = exports.__test;
  assert.equal(mergeFrame(null, SNAPSHOT), SNAPSHOT);
  const next = { ...SNAPSHOT, at: 1 };
  assert.equal(mergeFrame(SNAPSHOT, next), next);
  assert.equal(mergeFrame(SNAPSHOT, null), SNAPSHOT, '坏帧不许把已有快照清空');
});

check('client-10 状态卡：存储不可用横幅 + 源行「在位/故障」+ 故障原因就地落字', () => {
  const { exports } = loadClient(PAYLOAD);
  const tree = renderTree(exports.__test.components.StatusCard, { snap: SNAPSHOT, conn: { ok: true, note: '' }, checking: false, lastErr: '', onCheck() {} });
  const t = texts(tree).join('|');
  assert.match(t, /在位/);
  assert.match(t, /故障/);
  assert.match(t, /flight/, '榜单坏因要原样念出来');
  assert.match(t, /免费榜单（非官方源）/, 'v1.8 免费榜独立源必须在状态卡有自己的一行');
  const noStore = { ...SNAPSHOT, storage: { available: false } };
  const t2 = texts(renderTree(exports.__test.components.StatusCard, { snap: noStore, conn: { ok: true, note: '' }, checking: false, lastErr: '', onCheck() {} })).join('|');
  assert.match(t2, /无法留痕/);
});

check('client-11 新上卡：首轮建档提示在场；空态说「没有新上」而不是空白', () => {
  const { exports } = loadClient(PAYLOAD);
  const first = { ...SNAPSHOT, models: { ...SNAPSHOT.models, firstRun: true } };
  let t = texts(renderTree(exports.__test.components.NewModelsCard, { snap: first, showDays: 7 })).join('|');
  assert.match(t, /首轮建档/);
  const empty = { ...SNAPSHOT, models: { count: 0, firstRun: false, newThisWeek: [] } };
  t = texts(renderTree(exports.__test.components.NewModelsCard, { snap: empty, showDays: 7 })).join('|');
  assert.match(t, /没有新上模型/);
});

check('client-12 周榜卡：坏但留旧数据 → 说明是上次数据；全坏 → 空态一句实话', () => {
  const { exports } = loadClient(PAYLOAD);
  let t = texts(renderTree(exports.__test.components.TopCard, { snap: SNAPSHOT })).join('|');
  assert.match(t, /上次成功数据/);
  assert.match(t, /新见/, 'fixture 行没带 delta → 显示新见而不是持平');
  const nothing = { ...SNAPSHOT, top: { rows: [], days: 7, note: 'n' } };
  t = texts(renderTree(exports.__test.components.TopCard, { snap: nothing })).join('|');
  assert.match(t, /还没有成功解析/);
});

check('client-13 变化记录卡：事件行渲染 kind 中文标签；存储坏时空态文案改口', () => {
  const { exports } = loadClient(PAYLOAD);
  const t = texts(renderTree(exports.__test.components.EventsCard, { snap: SNAPSHOT })).join('|');
  assert.match(t, /新上模型/);
  const noStore = { ...SNAPSHOT, storage: { available: false }, events: [] };
  const t2 = texts(renderTree(exports.__test.components.EventsCard, { snap: noStore })).join('|');
  assert.match(t2, /存储不可用，变化不会留痕/);
});

check('client-14 设置条：间隔分段用宿主 labels，载荷缺失时直说「配置未就位」', () => {
  const { exports } = loadClient(PAYLOAD);
  const tree = renderTree(exports.__test.components.SettingsBar, { snap: SNAPSHOT, saving: false, savedNote: '', onInterval() {}, onSave() {} });
  const t = texts(tree).join('|');
  assert.match(t, /6 小时/);
  assert.match(t, /检查间隔/);
  // 选中态必须落在 snap.prefs.intervalMin 上（默认 1 小时 → 第 1 档亮）
  const onBtns = findByClass(tree, 'on');
  assert.equal(onBtns.length, 1, '分段器有且只有一个选中态');
  assert.equal(texts(onBtns[0]).join(''), '1 小时', '选中态要跟着 prefs.intervalMin 走');
  const bare = loadClient({ ...PAYLOAD, intervals: [] });
  const t2 = texts(renderTree(bare.exports.__test.components.SettingsBar, { snap: SNAPSHOT, saving: false, savedNote: '', onInterval() {}, onSave() {} })).join('|');
  assert.match(t2, /配置未就位/);
});

check('client-15 零浮层：渲染树里不存在 position:fixed/absolute 的 toast 类', () => {
  const { exports } = loadClient(PAYLOAD);
  assert.ok(!exports.__test.components.StatusCard.toString().includes('position:fixed'));
  const cssHasToast = /toast|notification-pop/i.test(JSON.stringify(exports.__test));
  assert.equal(cssHasToast, false);
});

check('client-16 consumeSse 半帧缓冲：跨 chunk 的帧拼回来才回调', async () => {
  const { exports } = loadClient(PAYLOAD);
  const { consumeSse } = exports.__test;
  const enc = new TextEncoder();
  const frames = [enc.encode('event: snapshot\ndata: {"a":'), enc.encode('1}\n\nevent: update\ndata: {"b":2}\n\n')];
  let i = 0;
  const res = { body: { getReader: () => ({ read: async () => (i < frames.length ? { done: false, value: frames[i++] } : { done: true }) }) } };
  const got = [];
  await consumeSse(res, (ev, data) => got.push([ev, JSON.stringify(data)]));
  assert.deepEqual(got, [['snapshot', '{"a":1}'], ['update', '{"b":2}']]);
});

check('client-17 consumeSse 忽略注释帧（: ok / : ping）与坏帧', async () => {
  const { exports } = loadClient(PAYLOAD);
  const { consumeSse } = exports.__test;
  const enc = new TextEncoder();
  const raw = ': ok\n\nevent: x\ndata: {bad json\n\nevent: snapshot\ndata: {"a":1}\n\n';
  const res = { body: { getReader: () => { let done = false; return { read: async () => done ? { done: true } : ((done = true), { done: false, value: enc.encode(raw) }) }; } } };
  const got = [];
  await consumeSse(res, (ev, data) => got.push([ev, JSON.stringify(data)]));
  assert.deepEqual(got, [['snapshot', '{"a":1}']]);
});

check('client-18 apply：没拿到 routePrefix 就一个入口都不注册', () => {
  const { exports } = loadClient();
  let slots = 0;
  const ctx = { effect: () => {}, slots: { inject: () => { slots += 1; }, register: () => {} } };
  exports.apply(ctx);
  assert.equal(slots, 0);
});

check('client-19 apply：载荷齐了注册侧边栏 + 主列两个 slot，id 一致', () => {
  const { exports } = loadClient(PAYLOAD);
  const regs = [];
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (name, fn) => fn(),
      register: (spec) => regs.push(spec),
    },
  };
  exports.apply(ctx);
  assert.equal(regs.length, 2);
  const ids = regs.map((r) => r.id ?? r.key);
  assert.deepEqual(ids, ['modelwatch', 'modelwatch'], '侧边栏与主列必须同 id 关联');
});

check('client-20 版式契约：主从栅格不做等高拉伸 / 状态压成横条 / 窄视口塌单列 / 禁容器查询', () => {
  const raw = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // 只认代码：注释里解释这些类名（含下面那条禁止 container-type 的说明）会被误判成命中
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/gm, '$1');
  assert.ok(!/\.mw-grid\b/.test(code), '旧版 2x2 等高网格 .mw-grid 不得复活（短卡会被拉高留白）');
  assert.match(code, /\.mw-cols\{[^}]*align-items:start/, '主从栅格必须 align-items:start：卡片按内容自然高度，不互相拉伸');
  assert.match(code, /\.mw-status\{[^}]*display:flex/, '状态必须是横条（.mw-status），不得退回竖直卡');
  assert.match(code, /@media \(max-width:1080px\)/, '窄视口必须塌成单列（断点与 stock 插件对齐）');
  assert.match(code, /\.mw-setrow\{[^}]*flex-direction:row/, '.mw-setrow 会挂在 .mw-card-b 上，必须显式写回 row');
  assert.match(code, /\.mw-root\{[^}]*width:100%/, '.mw-root 必须 width:100%：宽度不能由内容决定');
  // 真机事故（2026-10-01）：container-type:inline-size 施加 inline 轴 size containment，
  // 宿主主区是 flex、根容器又是 flex:0 1 auto ⇒ 根宽度算成 0，整页塌成"每张卡一条竖线"。
  // 兄弟插件（stock / sysops）一律只用 @media —— 这条负向断言就是防它再回来。
  assert.ok(!/container-type/.test(code), '禁止 container-type：宿主 flex 容器下根宽度会算成 0，整页塌成一列');
  assert.ok(!/@container/.test(code), '禁止 @container 断点：同上，改用 @media');
  // 真机事故（2026-10-02）：宿主 web 前端 CSS 里没有任何通配 box-sizing，而 `.mw-root *` 盖不到根自己
  // ⇒ 根是 content-box，`width:100%` + 左右各 20px padding 让外框比面板宽 40px，右侧被顶出可视区。
  // 兄弟插件（stock `.sa-root` / sysops `.so-root`）都把 box-sizing 写在根规则里。
  assert.match(code, /\.mw-root\{[^}]*box-sizing:border-box/, '根容器必须自己带 box-sizing:border-box（`.mw-root *` 盖不到根）');
  assert.ok(!/(^|[},;])\s*\*\s*\{[^}]*box-sizing/m.test(code),
    '不许用全局 通配 box-sizing 兜底：宿主没有，且它会掩盖根容器自身的盒模型问题');
  const proto = fs.readFileSync(new URL('../prototype/index.html', import.meta.url), 'utf8');
  // 同样要剥注释：原型里那句「不要给 .mw-root 加 container-type」的警告会命中自己
  const protoCode = proto.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/container-type|@container/.test(protoCode), '原型是 spec，同样禁止容器查询（要与真机同构）');
  // 原型与真机必须同构 —— 上次「实际效果跟原型不一样」就是因为原型停在旧版式
  for (const marker of ['.mw-tabs', '.mw-panel{', '.mw-podium', '.mw-bar', '.mw-rank-1', '.mw-rank-3',
    '.mw-setlabel', '.mw-card-h .mw-card-n+.mw-link', 'mw-panel[hidden]']) {
    assert.ok(protoCode.includes(marker), `原型缺样式 ${marker}：原型演进必须跟着 client.js 同步`);
  }
  assert.match(protoCode, /\.mw-root\{[^}]*box-sizing:border-box/,
    '原型根容器也要 border-box，且不许用全局重置代替（否则同类 bug 在原型里永远看不见）');
  assert.ok(!/(^|[},;])\s*\*\s*\{[^}]*box-sizing/m.test(protoCode),
    '原型不许用全局通配 box-sizing：会掩盖根容器盒模型问题');
  assert.ok(code.includes('.mw-card-h .mw-card-n+.mw-link'),
    'client.js 也要有「计数+链接」贴靠规则（原型已定，两处不许漂）');
});

check('client-21 页签与徽标：6 个页签 / 前三名金银铜 / 每个偏好字段都有入口', () => {
  const { exports } = loadClient(PAYLOAD);
  const T = exports.__test.TABS;
  assert.equal(T.length, 6, '页签数应为 6');
  // vm 里造的数组跨 realm 比不了原型，按 JSON 形状断言（同 client-07）
  assert.equal(JSON.stringify(T.map((t) => t.id)), JSON.stringify(['overview', 'top', 'free', 'new', 'events', 'settings']));
  const bar = texts(renderTree(exports.__test.components.TabBar, { tab: 'top', onTab() {}, snap: SNAPSHOT })).join('|');
  for (const l of ['总览', '热门周榜', '免费榜单', '新上模型', '变化记录', '设置']) {
    assert.ok(bar.includes(l), `页签栏缺「${l}」`);
  }
  assert.match(bar, /热门周榜\|2/, '页签计数要跟着数据走（fixture 周榜 2 行）');
  assert.match(bar, /免费榜单\|1/, '免费榜计数同样跟着数据走（fixture 免榜 1 行）');

  // 徽标：前三名走金/银/铜，第 4 名起回落中性
  const rb = exports.__test.components.RankBadge;
  assert.match(renderTree(rb, { rank: 1 }).props.className, /mw-rank-1/);
  assert.match(renderTree(rb, { rank: 3 }).props.className, /mw-rank-3/);
  assert.match(renderTree(rb, { rank: 9 }).props.className, /mw-rank-n/);
  assert.match(renderTree(rb, { rank: 1 }).props.className, /mw-rank(?!-n)/, '第 1 名不许落到中性样式');

  const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/gm, '$1');
  assert.match(code, /useState\('overview'\)/, '默认落在总览页');
  // 存了却没有任何控件去改的偏好字段等于没有（keepEvents 曾经就是这种）
  for (const k of ['intervalMin', 'topN', 'keepEvents']) {
    assert.match(code, new RegExp(`\\b${k}\\b`), `偏好 ${k} 必须有改它的入口`);
  }
  assert.ok(!/Math\.max\(50,\s*Math\.min\(2000/.test(code), '取值边界只允许从 cfg().keepEventsRange 读，不许在客户端再写一份');

  // 原型页签必须与 TABS 逐一对齐（缺一个 = 原型又落后于实现）
  const proto = fs.readFileSync(new URL('../prototype/index.html', import.meta.url), 'utf8');
  for (const id of ['overview', 'top', 'free', 'new', 'events', 'settings']) {
    assert.ok(proto.includes(`data-tab="${id}"`), `原型缺页签按钮 ${id}`);
  }
  assert.match(proto, /id="p-overview"/, '原型缺总览面板容器');
  for (const id of ['top', 'free', 'new', 'events', 'settings']) {
    assert.ok(proto.includes(`id="p-${id}"`), `原型缺面板容器 p-${id}`);
  }
  // 原型设置页的选中档 = 出厂默认（默认值改了一个地方没跟上，这里会红）
  assert.match(proto, /class="on">\s*1 小时/, '原型设置页默认选中档必须与 DEFAULT_PREFS.intervalMin 一致');
});

check('client-22 免费榜单卡：独立源独立闸门；来源文案吃宿主 note，不自编', () => {
  const { exports } = loadClient(PAYLOAD);
  const TC = exports.__test.components.TopCard;
  const freeProps = { board: 'free', title: '免费榜单', empty: '免费榜源还没有成功返回过模型', srcKey: 'free' };
  // SNAPSHOT：周榜源坏、免费榜源好 ⇒ 免费榜卡不许挂横幅（v1.8 起两榜各挂各的闸）
  const t = texts(renderTree(TC, { snap: SNAPSHOT, ...freeProps })).join('|');
  assert.ok(t.includes('免费榜单'), '卡题走参数，不写死热门周榜');
  assert.ok(t.includes('p/m3:free'), '免费行 slug 带 :free 后缀原样渲染');
  assert.ok(!t.includes('本轮榜单源故障'), '周榜源坏不连坐免费榜：闸门必须各挂各的');
  assert.ok(t.includes('免榜来源注'), '来源注来自快照 free.note（宿主单点）');
  assert.ok(!t.includes('来源：榜单前端 API'), 'client 不许内置宿主文案');
  assert.match(t, /▲2/, 'delta 走与周榜同一套渲染（▲/▼/新见）');

  // 免费榜源自己坏：横幅就地标注，且念的是免费榜源的原因
  const freeBad = { ...SNAPSHOT, sources: { ...SNAPSHOT.sources, free: { ok: false, error: '免费榜源返回 503', checkedAt: 1790690000000, unofficial: true, note: 'n' } } };
  const t1 = texts(renderTree(TC, { snap: freeBad, ...freeProps })).join('|');
  assert.ok(t1.includes('本轮榜单源故障') && t1.includes('503'), '免费榜坏轮要说明是上次数据');
  const okTop = texts(renderTree(TC, { snap: freeBad })).join('|');
  assert.ok(!okTop.includes('503'), '免费榜源坏也不该在周榜卡上冒 503（反向不连坐）');

  const emptySnap = { ...SNAPSHOT, free: { rows: [], days: 7, note: 'n' } };
  const t3 = texts(renderTree(TC, { snap: emptySnap, ...freeProps })).join('|');
  assert.ok(t3.includes('免费榜源还没有成功返回过模型'), '空态要说实话而不是空白');
});

check('client-24 tab 路由：两个榜各挂各的源闸门，srcKey 由路由传下去', () => {
  const render = (tab, snap) => texts(renderPage(loadClient(PAYLOAD, { tab, snap }).exports.__test.components.ModelwatchPage)).join('|');
  // 周榜源坏、免费榜源好：免费榜页不许出横幅（路由漏传 srcKey 就会串到周榜闸门上）
  const free = render('free', SNAPSHOT);
  assert.ok(free.includes('p/m3:free'), 'tab=free 渲染的是免费榜行');
  assert.ok(!free.includes('本轮榜单源故障'), '免费榜页不许挂周榜源的故障横幅');
  // 反向：周榜页必须挂上自己那口锅
  const top = render('top', SNAPSHOT);
  assert.ok(top.includes('本轮榜单源故障') && top.includes('flight'), 'tab=top 显示的是周榜源故障与原因');
  assert.ok(!top.includes('p/m3:free'), 'tab=top 不许渲染免费榜行');
  // 免费榜自己坏：横幅在免费榜页出现，原因念的是免费榜源的
  const freeBad = { ...SNAPSHOT, sources: { ...SNAPSHOT.sources, rankings: { ...SNAPSHOT.sources.rankings, ok: true }, free: { ok: false, error: '免费榜源返回 503', checkedAt: 1, unofficial: true, note: 'n' } } };
  const f2 = render('free', freeBad);
  assert.ok(f2.includes('本轮榜单源故障') && f2.includes('503'), '免费榜坏轮要在自己页上如实标注');
});

check('client-23 页头信号：三源名册含免费榜源，坏/缺都能落到 pill 文案与 tooltip', () => {
  const { exports } = loadClient(PAYLOAD);
  const allOk = { ...SNAPSHOT, sources: { ...SNAPSHOT.sources, rankings: { ...SNAPSHOT.sources.rankings, ok: true } } };
  const pill = (snap) => {
    const tree = renderTree(exports.__test.components.Header, { snap, conn: { ok: true, note: '' }, checking: false, lastErr: '', onCheck() {} });
    const node = findByClass(tree, 'mw-pill')[0];
    return { text: texts(node).join(''), cls: node.children[0].props.className, tip: node.props.title || '' };
  };
  let p = pill(allOk);
  assert.match(p.text, /数据源全部在位/);
  assert.match(p.cls, /mw-dot-ok/);
  // 只有免费榜源坏：页头必须点名「免费榜源」，不能含糊成「周榜源」或漏报
  const freeOnly = { ...allOk, sources: { ...allOk.sources, free: { ok: false, error: '免费榜源返回 503', checkedAt: 1, unofficial: true, note: 'n' } } };
  p = pill(freeOnly);
  assert.match(p.text, /免费榜源故障/);
  assert.match(p.cls, /mw-dot-err/);
  assert.match(p.tip, /免费榜源：免费榜源返回 503/, '坏因要在 tooltip 里');
  // 免费榜源整体缺席（旧档快照）：不能假装全在位
  const { free: _gone, ...noFree } = allOk.sources;
  p = pill({ ...allOk, sources: noFree });
  assert.match(p.text, /部分源未就位/);
  assert.match(p.cls, /mw-dot-warn/);
});

await runAll('client');
