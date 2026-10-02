/**
 * lib/services/models.js —— 官方清单源：GET /api/v1/models。
 *
 * 纯函数与 IO 分开：normalizeModels / newWithin / diffIds 可脱离网络测；
 * fetchModels 只包一层 fetchFn 注入（超时 + 三档失败原因，绝不抛到编排层之外）。
 */
import { NEW_WINDOW_DAYS_SHOW, NEW_WINDOW_DAYS_KEEP, NEW_RECENT_CAP } from '../domain.js';

export const MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** pricing 的 "0.0000025"（美元/token）折成美元/1M tokens；脏值归 undefined 而不是 0。 */
function per1M(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n * 1_000_000;
}

/** 把 API 原始行规范化成 MODEL_ROW_SHAPE 认识的字段（未识别字段一概不带）。 */
export function normalizeModels(json) {
  const list = json && typeof json === 'object' ? json.data : null;
  if (!Array.isArray(list)) {
    throw Object.assign(new Error('清单响应缺少 data 数组'), { code: 'BAD_SHAPE' });
  }
  const rows = [];
  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) continue;
    const row = {
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      created: Number.isFinite(Number(m.created)) ? Number(m.created) : 0,
    };
    const ctx = Number(m.context_length);
    if (Number.isFinite(ctx)) row.contextLength = ctx;
    const p = m.pricing && typeof m.pricing === 'object' ? m.pricing : {};
    const inM = per1M(p.prompt); const outM = per1M(p.completion);
    if (inM !== undefined) row.priceInM = inM;
    if (outM !== undefined) row.priceOutM = outM;
    rows.push(row);
  }
  return rows;
}

/** 近 N 天上架（含 :batch 变体原样保留 —— 一份真相：id 是 API 给什么存什么）。 */
export function newWithin(rows, days, nowMs) {
  const cutoffSec = nowMs / 1000 - days * 86400;
  return rows
    .filter((r) => r.created > cutoffSec)
    .sort((a, b) => b.created - a.created);
}

export function newThisWeek(rows, nowMs) {
  return newWithin(rows, NEW_WINDOW_DAYS_SHOW, nowMs);
}

/** 留档窗口再按条数封顶（防单行越写越肥）。 */
export function newRecentForState(rows, nowMs) {
  return newWithin(rows, NEW_WINDOW_DAYS_KEEP, nowMs).slice(0, NEW_RECENT_CAP);
}

/** 集合差：added = 本轮有而上轮没有；removed 反向。首轮（prev=null）不产差异。 */
export function diffIds(prevIds, nextIds) {
  if (!Array.isArray(prevIds)) return { added: [], removed: [], firstRun: true };
  const prev = new Set(prevIds);
  const next = new Set(nextIds);
  return {
    added: nextIds.filter((id) => !prev.has(id)),
    removed: prevIds.filter((id) => !next.has(id)),
    firstRun: false,
  };
}

/**
 * 拉取 + 规范化。返回 `{ ok, rows }` 或 `{ ok:false, error }`，error 是人话（原样进状态卡）。
 * fetchFn / timeoutMs 注入是为了测试不碰网。
 */
export async function fetchModels({ fetchFn = globalThis.fetch, url = MODELS_URL, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchFn(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `清单源返回 ${res.status}` };
    const rows = normalizeModels(await res.json());
    if (!rows.length) return { ok: false, error: '清单源返回空列表（疑似响应结构变化）' };
    return { ok: true, rows };
  } catch (e) {
    const why = e?.name === 'AbortError' ? `清单源超时（${Math.round(timeoutMs / 1000)}s）` : `清单源请求失败：${e?.message ?? e}`;
    return { ok: false, error: why };
  } finally {
    clearTimeout(timer);
  }
}
