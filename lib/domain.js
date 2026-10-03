/**
 * lib/domain.js —— 一份真相：表 schema、枚举、界面文案表都只在这一处定义。
 *
 * 浏览器半边不复制判定，只渲染宿主 snapshot() 交出去的字段；
 * EVENT_KIND_LABELS 同时是「变化记录」时间线的中文标签单点（spec §7.4）。
 */
import {
  defineDomain, domainTable, record,
  requiredString, optionalString, requiredInt, optionalInt,
  requiredNumber, optionalNumber, requiredBool, optionalBool,
  requiredEnum, arrayOfItem, arrayOf,
} from './kv-schema.js';

/** 检查间隔的封闭档位（分钟）；界面分段器与宿主钳制共用这一张表。 */
export const CHECK_INTERVALS = [60, 360, 720, 1440];
export const CHECK_INTERVAL_LABELS = { 60: '1 小时', 360: '6 小时', 720: '12 小时', 1440: '24 小时' };

/** 榜单显示条数的边界（周榜源固定 20 行，topN 只能在这之间）。 */
export const TOP_N_MIN = 5;
export const TOP_N_MAX = 20;

/** 事件流水保留条数的边界（超出裁老，防止 KV 无限增长）。
 *  ★ 钳制（stores）与界面控件（client 的 ±）必须 import 这两个常量，
 *    两边各写一个数就会出现「界面允许填、宿主静默改回」的错觉。 */
export const KEEP_EVENTS_MIN = 50;
export const KEEP_EVENTS_MAX = 2000;
export const KEEP_EVENTS_STEP = 100;

/** 出厂偏好。★ intervalMin 必须是 CHECK_INTERVALS 里的成员：
 *  另起一个「界面上选不中」的数，用户改完设置再进设置页就会看到幽灵档位。
 *  v1.5 起默认 1 小时（榜单源刷新粒度约「天」，1 小时已足够早发现来源失效）。 */
export const DEFAULT_PREFS = {
  intervalMin: 60,
  topN: 15,
  keepEvents: 500,
};

/** 变化流水的事件种类（封闭集合，越界值进不了库）。 */
export const EVENT_KINDS = [
  'new_model', 'removed_model',
  'top_enter', 'top_exit', 'top_move',
  'source_error', 'source_recover', 'baseline',
];
export const EVENT_KIND_LABELS = {
  new_model: '新上模型',
  removed_model: '模型下架',
  top_enter: '新晋周榜',
  top_exit: '跌出周榜',
  top_move: '周榜位次变化',
  source_error: '数据源故障',
  source_recover: '数据源恢复',
  baseline: '首次建档',
};

/** 近 30 天上架清单的存表上限与展示窗口（spec §3：7 天展示、30 天留档）。 */
export const NEW_WINDOW_DAYS_SHOW = 7;
export const NEW_WINDOW_DAYS_KEEP = 30;
export const NEW_RECENT_CAP = 60;

/** 进/出榜之外，位次挪动达到这个数才记 top_move（以下视为周榜滚动噪声）。 */
export const TOP_MOVE_THRESHOLD = 3;

/** 规范化后的模型行（newRecent 与快照共用）。价格单位：美元 / 1M tokens。 */
export const MODEL_ROW_SHAPE = {
  id: requiredString('模型 id'),
  name: requiredString('模型名'),
  created: requiredNumber('上架时间戳(秒)'),
  contextLength: optionalNumber('上下文长度'),
  priceInM: optionalNumber('输入价 $/1M'),
  priceOutM: optionalNumber('输出价 $/1M'),
};

/** 周榜一行：rank 由源数组顺序给出，delta 由宿主与上轮比对现算。 */
export const TOP_ROW_SHAPE = {
  rank: requiredInt('名次'),
  slug: requiredString('模型 slug'),
  tokens: requiredNumber('周 token 用量'),
  delta: optionalInt('名次变化'),
};

const stateRecord = record({
  at: requiredNumber('检查时间'),
  modelCount: requiredInt('模型总数'),
  modelIds: arrayOfItem('id 全集', requiredString('模型 id')),
  newRecent: arrayOf('近 30 天新上', MODEL_ROW_SHAPE),
  top: arrayOf('周榜', TOP_ROW_SHAPE),
  prevTop: arrayOfItem('上轮周榜 slug', requiredString('slug')),
  // 免费榜条目为后加字段：可选（缺省即库里没有），旧档照读照写不受影响。
  // v1.8 起免费榜是独立源（自己的闸门），状态位与周榜的 rankOk 分开记。
  freeTop: arrayOf('免费周榜', TOP_ROW_SHAPE),
  prevFreeTop: arrayOfItem('上轮免费榜 slug', requiredString('slug')),
  freeOk: optionalBool('免费榜源状态'),
  freeError: optionalString('免费榜源故障原因'),
  baseline: optionalBool('首轮建档标记'),
  modelsOk: requiredBool('清单源状态'),
  modelsError: optionalString('清单源故障原因'),
  rankOk: requiredBool('榜单源状态'),
  rankError: optionalString('榜单源故障原因'),
}, 'state 记录');

const eventRecord = record({
  id: requiredString('事件 id'),
  at: requiredNumber('发生时间'),
  kind: requiredEnum('事件种类', EVENT_KINDS),
  slug: optionalString('模型 slug'),
  detail: optionalString('补充说明'),
}, '事件记录');

const prefsRecord = record({
  intervalMin: requiredInt('检查间隔(分)'),
  topN: requiredInt('榜单条数'),
  keepEvents: requiredInt('流水保留条数'),
}, '偏好记录');

export const MODELWATCH_DOMAIN = defineDomain({
  name: 'modelwatch',
  version: 1,
  tables: {
    state: domainTable(stateRecord),
    events: domainTable(eventRecord),
    prefs: domainTable(prefsRecord),
  },
});
