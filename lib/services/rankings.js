/**
 * lib/services/rankings.js —— 热门周榜：解析 /rankings 页面内嵌的 react-query 水合数据。
 *
 * ⚠️ 非官方数据源（spec §1）：解析路径 = Next.js flight 字符串 → 反转义拼接 →
 * 平衡花括号扫描取 `{"dehydratedAt"…}` 对象 → 认 `queryKey:["rankings","models",…]`。
 * 页面改版即失效 —— 失败一律返回 `{ ok:false, reason }`（人话，绝不抛），
 * 由编排层落 `source_error` 事件并在榜单卡就地标注。
 */
import { TOP_N_MAX } from '../domain.js';

export const RANKINGS_URL = 'https://openrouter.ai/rankings';
/** 就地标注用的常驻文案：浏览器半边渲染它，不在 client 里重写一份（一份真相）。 */
export const RANKINGS_SOURCE_NOTE = '来源：榜单页内嵌数据（非官方接口），页面改版会失效';

const FLIGHT_CHUNK_RE = /self\.__next_f\.push\(\[\d+,"((?:[^"\\]|\\.)*)"\]\)/g;

/** 从字符串 start 处的 `{` 起做平衡扫描（处理字符串内的括号与转义），返回对象原文或 null。 */
export function balancedObjectAt(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

/** flight chunk 正文是合法 JS 字符串字面量体；逐段反转义，坏段跳过（不因一段坏丢整榜）。 */
export function unescapeChunks(chunks) {
  const parts = [];
  for (const c of chunks) {
    try { parts.push(JSON.parse('"' + c + '"')); } catch { /* 坏段跳过 */ }
  }
  return parts.join('');
}

/** 是「周榜/榜单 models 视图」的水合对象吗？queryKey 形状：["rankings","models",{view}]。 */
function isRankingsModelEntry(o) {
  if (!o || typeof o !== 'object') return false;
  const qk = o.queryKey;
  return Array.isArray(qk) && qk[0] === 'rankings' && qk[1] === 'models';
}

/**
 * 主解析。返回 `{ ok:true, view, rows:[{ slug, tokens }] }`（rows 保持源数组顺序 = 榜单名次）
 * 或 `{ ok:false, reason }`。
 */
export function parseRankingsHtml(html) {
  if (typeof html !== 'string' || !html) return { ok: false, reason: '榜单页响应为空' };
  const chunks = [];
  let m;
  FLIGHT_CHUNK_RE.lastIndex = 0;
  while ((m = FLIGHT_CHUNK_RE.exec(html))) chunks.push(m[1]);
  if (!chunks.length) return { ok: false, reason: '页面结构变化：没找到 flight 数据段' };
  const stream = unescapeChunks(chunks);
  if (!stream) return { ok: false, reason: 'flight 数据段全部反转义失败' };

  const found = [];
  let p = 0;
  while ((p = stream.indexOf('{"dehydratedAt"', p)) >= 0) {
    const raw = balancedObjectAt(stream, p);
    p += 1;
    if (!raw) continue;
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    if (isRankingsModelEntry(obj)) found.push(obj);
  }
  if (!found.length) return { ok: false, reason: '页面结构变化：水合数据里没有榜单对象' };

  // 多视图并存时优先 week；都没有就取第一个能用的。
  const pick = found.find((o) => o?.queryKey?.[2]?.view === 'week') ?? found[0];
  const data = pick?.state?.data;
  if (!Array.isArray(data)) return { ok: false, reason: '榜单数据结构变化：data 不是数组' };

  const rows = [];
  for (const r of data) {
    if (!r || typeof r !== 'object') continue;
    if (r.variant && r.variant !== 'standard') continue; // :batch 等变体不单列（spec §2）
    const slug = typeof r.model_permaslug === 'string' && r.model_permaslug ? r.model_permaslug : null;
    if (!slug) continue;
    const tokens = [r.total_prompt_tokens, r.total_completion_tokens]
      .map(Number).filter((n) => Number.isFinite(n) && n >= 0)
      .reduce((a, b) => a + b, 0);
    rows.push({ slug, tokens });
    if (rows.length >= TOP_N_MAX) break;
  }
  if (!rows.length) return { ok: false, reason: '榜单数据结构变化：没有可用行（字段漂移）' };
  const view = pick?.queryKey?.[2]?.view ?? 'unknown';
  return { ok: true, view, rows };
}

/** 拉取 + 解析。fetchFn 注入为测试不碰网；失败口径同 fetchModels。 */
export async function fetchRankings({
  fetchFn = globalThis.fetch, url = RANKINGS_URL, timeoutMs = 30000,
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchFn(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (dsh-plugin-modelwatch; personal monitor)' },
    });
    if (!res.ok) return { ok: false, reason: `榜单源返回 ${res.status}` };
    const parsed = parseRankingsHtml(await res.text());
    return parsed.ok ? { ...parsed, fetchedAt: Date.now() } : parsed;
  } catch (e) {
    const why = e?.name === 'AbortError' ? `榜单源超时（${Math.round(timeoutMs / 1000)}s）` : `榜单源请求失败：${e?.message ?? e}`;
    return { ok: false, reason: why };
  }
}
