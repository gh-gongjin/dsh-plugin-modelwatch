/**
 * ============================================================
 * dsh-plugin-modelwatch —— Host Half（宿主半边）index.js
 * ============================================================
 *
 * 装配四件事（与 sysops 同形，业务面小得多）：
 *   1. 三仓储（state / events / prefs）+ 检查服务 + lib/api.js 门面接到 ctx；
 *   2. 按需探测宿主能力（storageDomain / timer / webServer），缺哪项就怎么降级；
 *   3. 经 `webserver/index-inject` 把配置与能力表推给浏览器半边；
 *   4. 注册 `/modelwatch` 前缀路由，生命周期结束时先停定时器、后关存储句柄。
 *
 * 铁律（spec §0）：
 *   · 零 @deepseek-ai/* import —— link: 挂载会解析出第二份模块实例；
 *   · 零第三方依赖 —— 出网只用全局 fetch；
 *   · 对 OpenRouter 全程只读 GET，不 POST、不带 key、不写本机任何文件（KV 走宿主设施）。
 *
 * 为什么 inject = []：Cordis 的 Context 是代理，未 inject 的属性读了就抛；
 * 把 webServer / storageDomain / timer 写进 inject 会让「宿主缺任一服务」直接卡死插件加载。
 *
 * ⚠️ ctx.inject 回调跑在独立 fiber，不在 apply 同步段执行；能力位与路由注册只能在回调里做
 *    （sysops 病历：apply 顶层锁死能力快照 ⇒ 满屏降级横幅 + 路由全 404）。
 */
import {
  createApiHandler, ROUTE_PREFIX, GLOBAL_KEY,
} from './lib/api.js';
import { createCaps } from './lib/caps.js';
import { createStateStore, createEventStore, createPrefsStore } from './lib/stores.js';
import { createCheckService } from './lib/check.js';
import {
  CHECK_INTERVALS, CHECK_INTERVAL_LABELS, DEFAULT_PREFS,
  TOP_N_MIN, TOP_N_MAX, KEEP_EVENTS_MIN, KEEP_EVENTS_MAX, KEEP_EVENTS_STEP,
  EVENT_KIND_LABELS, NEW_WINDOW_DAYS_SHOW,
} from './lib/domain.js';
import { RANKINGS_SOURCE_NOTE } from './lib/services/rankings.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'modelwatch';

/** 零硬 inject：三项服务全部按需注入，缺了也不阻塞加载。 */
export const inject = [];

/**
 * 默认配置。panelOrder:14 排在股票（10）与运维（12）下方。
 * autoCheckOnStart：启动 5s 后跑第一轮（给 storageDomain 注入回调留落地窗口）。
 */
export const DEFAULT_CONFIG = {
  panelId: 'modelwatch',
  panelOrder: 14,
  label: '模型监控',
  intervalMin: DEFAULT_PREFS.intervalMin,
  topN: DEFAULT_PREFS.topN,
  keepEvents: DEFAULT_PREFS.keepEvents,
  autoCheckOnStart: true,
};

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 逐键钳制用户配置（profile 可覆盖）；只认已知键，脏值绝不带进运行时。 */
export function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!CHECK_INTERVALS.includes(Number(cfg.intervalMin))) cfg.intervalMin = DEFAULT_CONFIG.intervalMin;
  cfg.topN = clampInt(cfg.topN, DEFAULT_CONFIG.topN, TOP_N_MIN, TOP_N_MAX);
  cfg.keepEvents = clampInt(cfg.keepEvents, DEFAULT_CONFIG.keepEvents, 50, 2000);
  cfg.autoCheckOnStart = Boolean(cfg.autoCheckOnStart);
  if (typeof cfg.label !== 'string' || !cfg.label) cfg.label = DEFAULT_CONFIG.label;
  if (typeof cfg.panelId !== 'string' || !cfg.panelId) cfg.panelId = DEFAULT_CONFIG.panelId;
  cfg.panelOrder = Number.isFinite(Number(cfg.panelOrder)) ? Math.trunc(Number(cfg.panelOrder)) : DEFAULT_CONFIG.panelOrder;
  return cfg;
}

/** 模块级最近一次装配的运行时快照，仅测试可观测性用（见 __peek）。 */
let lastRuntime = null;

/** 测试钩子：读装配后的运行时诊断（timerBackend）。生产路径不依赖它。 */
export function __peek(key) {
  const rt = lastRuntime;
  if (!rt || !key) return undefined;
  if (key === 'timerBackend') {
    try { return rt.check.timerBackend; } catch { return undefined; }
  }
  return undefined;
}

/**
 * 插件入口。
 * @param ctx 宿主 Context（代理对象，未 inject 的属性读了会抛）。
 * @param config profile 为本插件写的 config —— 只能从第二个参数拿，读 ctx.config 会抛。
 * @returns 生命周期清理器（同步执行）。
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);

  /* ---- 1. 宿主服务句柄：由 ctx.inject 回调延后填入 ---- */
  let storageFacility;
  let intervalFn = null;
  let webServer;

  /* ---- 2. 能力：现取现算 ---- */
  const getFacility = () => storageFacility;
  const caps = createCaps({ logger: ctx.logger });
  let storageOpenFailure = '';
  function syncCaps() {
    caps.mark(
      'storageDomain',
      Boolean(storageFacility) && !storageOpenFailure,
      !storageFacility ? '宿主未提供 ctx.storageDomain' : storageOpenFailure,
    );
    caps.mark('timer', Boolean(intervalFn), intervalFn ? '' : '宿主未提供 ctx.timer.interval，已退到 setInterval');
    caps.mark('webServer', Boolean(webServer), webServer ? '' : '宿主未提供 webServer，一个入口都不注册');
  }

  /* ---- 3. 仓储与偏好同步视图 ---- */
  const stateStore = createStateStore({ getFacility, logger: ctx.logger });
  const eventStore = createEventStore({ getFacility, logger: ctx.logger, now: () => Date.now() });
  const prefsStore = createPrefsStore({ getFacility, logger: ctx.logger });

  let prefsView = {
    intervalMin: resolved.intervalMin,
    topN: resolved.topN,
    keepEvents: resolved.keepEvents,
  };
  async function reloadPrefs() {
    try {
      prefsView = await prefsStore.read();
      storageOpenFailure = '';
    } catch (e) {
      if (storageFacility) {
        storageOpenFailure = '存储域 open 失败，偏好转只读';
        ctx.logger?.warn?.(`[modelwatch] 存储域不可用（${e?.message ?? e}），偏好转默认值`);
      }
    }
    syncCaps();
  }
  const getPrefs = () => prefsView;

  /* ---- 4. 检查服务 + 事件扇出 ---- */
  const fanout = new Set();
  const check = createCheckService({
    getPrefs,
    stateStore,
    eventStore,
    logger: ctx.logger,
    now: () => Date.now(),
    getIntervalFn: () => intervalFn,
    onEvent: (ev) => { for (const f of [...fanout]) { try { f(ev); } catch { /* 单个订阅者坏不掉别人 */ } } },
  });

  async function onPrefsChanged() {
    await reloadPrefs();
    check.setCadence(prefsView.intervalMin);
  }

  /* ---- 5. api 门面 ---- */
  const apiHandler = createApiHandler({
    check,
    stateStore,
    eventStore,
    prefsStore,
    caps,
    logger: ctx.logger,
    now: () => Date.now(),
    onPrefsChanged,
    subscribeEvent: (fn) => { fanout.add(fn); return () => fanout.delete(fn); },
  });

  /* ---- 6. 生命周期收口：先停定时器与推流，后关存储句柄 ---- */
  function teardown() {
    try { check.dispose(); } catch (e) { ctx.logger?.warn?.(`[modelwatch] 停检查服务失败：${e?.message ?? e}`); }
    try { apiHandler.dispose?.(); } catch (e) { ctx.logger?.warn?.(`[modelwatch] 释放接口订阅失败：${e?.message ?? e}`); }
    for (const s of [stateStore, eventStore, prefsStore]) {
      Promise.resolve(s.close?.()).catch((e) => ctx.logger?.warn?.(`[modelwatch] 关闭存储句柄失败：${e?.message ?? e}`));
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => teardown, 'modelwatch:lifecycle');
  lastRuntime = { check, teardown };

  /* ---- 7. 启动节拍与首轮检查 ---- */
  check.setCadence(prefsView.intervalMin);
  if (resolved.autoCheckOnStart) {
    const t = setTimeout(() => {
      check.run({ trigger: 'startup' }).catch((e) => ctx.logger?.warn?.(`[modelwatch] 启动首轮检查失败：${e?.message ?? e}`));
    }, 5000);
    if (typeof t.unref === 'function') t.unref();
  }

  ctx.inject(['storageDomain'], (s) => {
    storageFacility = s.storageDomain;
    syncCaps();
    void reloadPrefs().then(() => check.setCadence(prefsView.intervalMin));
  });

  ctx.inject(['timer'], (t) => {
    if (t.timer && typeof t.timer.interval === 'function') intervalFn = (fn, ms) => t.timer.interval(fn, ms);
    syncCaps();
    try {
      check.setCadence(prefsView.intervalMin);   // 宿主定时器就绪后重挂节拍（能力位不再自相矛盾）
    } catch (e) {
      ctx.logger?.warn?.(`[modelwatch] 宿主定时器就绪后重挂节拍失败：${e?.message ?? e}`);
    }
  });

  ctx.inject(['webServer'], (w) => {
    webServer = w.webServer;
    syncCaps();
    const register = () => {
      const disposer = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res, body) => apiHandler(req, res, body) });
      return typeof disposer === 'function' ? disposer : () => {};
    };
    if (typeof w.effect === 'function') w.effect(register, 'modelwatch:route');
    else register();
  });

  /* ---- 8. 入口载荷：只有 webServer 到位才推（点开空白页比看不到入口更糟）---- */
  ctx.on('webserver/index-inject', (table) => {
    if (!webServer) return;
    syncCaps();
    table.push({
      kind: 'global',
      name: GLOBAL_KEY,
      value: {
        panelId: resolved.panelId,
        label: resolved.label,
        panelOrder: resolved.panelOrder,
        routePrefix: ROUTE_PREFIX,
        api: `${ROUTE_PREFIX}/api`,
        capabilities: caps.read(),
        capabilityRows: caps.rows(),
        intervals: CHECK_INTERVALS,
        intervalLabels: CHECK_INTERVAL_LABELS,
        topNRange: { min: TOP_N_MIN, max: TOP_N_MAX },
        keepEventsRange: { min: KEEP_EVENTS_MIN, max: KEEP_EVENTS_MAX, step: KEEP_EVENTS_STEP },
        eventKindLabels: EVENT_KIND_LABELS,
        showDays: NEW_WINDOW_DAYS_SHOW,
        sourceNote: RANKINGS_SOURCE_NOTE,
        defaults: { ...DEFAULT_PREFS },
        builtAt: Date.now(),
      },
    });
  });

  return teardown;
}
