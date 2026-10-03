import { check, runAll, assert, fixture } from './_helpers.mjs';
import {
  balancedObjectAt, unescapeChunks, parseRankingsHtml, fetchRankings,
  parseFreeRankingsJson, fetchFreeRankings,
  RANKINGS_URL, RANKINGS_SOURCE_NOTE, FREE_RANKINGS_NOTE, FREE_RANKINGS_URL,
} from '../lib/services/rankings.js';

const weekHtml = await fixture('rankings-week.html');
const emptyHtml = await fixture('rankings-empty.html');
const freeJson = await fixture('free-week.json');

/** 造一段最小 flight 文档：body 会被当成 JS 字符串字面量体（JSON.stringify 负责转义）。 */
function flightDoc(...bodies) {
  const scripts = bodies.map((b) => `<script>self.__next_f.push([1,${JSON.stringify(b)}])</script>`).join('');
  return `<!DOCTYPE html><html><head>${scripts}</head><body>x</body></html>`;
}
function dehydratedObj(queryKey, data) {
  return JSON.stringify({ dehydratedAt: 1, state: { data }, queryKey, queryHash: 'h' });
}

check('rank-01 balancedObjectAt 嵌套字符串里的花括号与转义引号不迷路', () => {
  const s = 'xx{"a":"b}c{d","e":"\\"{\\"}","f":{"g":[1,2]}}tail';
  const start = s.indexOf('{');
  const raw = balancedObjectAt(s, start);
  assert.ok(raw);
  const o = JSON.parse(raw);
  assert.deepEqual(o.f.g, [1, 2]);
});

check('rank-02 balancedObjectAt 截断输入返回 null 而不是抛', () => {
  assert.equal(balancedObjectAt('{"a":{', 0), null);
});

check('rank-03 balancedObjectAt 在配对闭合处收口，多余的右花括号不进结果', () => {
  assert.equal(balancedObjectAt('{"a":1}}', 0), '{"a":1}');
});

check('rank-04 unescapeChunks 坏段跳过、好段保留（不因一段坏丢整榜）', () => {
  const parts = unescapeChunks(['hello', 'bad\\', 'world']);
  assert.ok(parts.includes('hello'));
  assert.ok(parts.includes('world'));
});

check('rank-05 parseRankingsHtml 对空/非字符串给降级理由不抛', () => {
  for (const bad of ['', null, 42, {}]) {
    const r = parseRankingsHtml(bad);
    assert.equal(r.ok, false);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  }
});

check('rank-06 没有 flight 段的页面报结构变化（真改版场景）', () => {
  const r = parseRankingsHtml(emptyHtml);
  assert.equal(r.ok, false);
  assert.match(r.reason, /flight|结构/);
});

check('rank-07 有 flight 段但没有榜单对象：报「没有榜单对象」', () => {
  const r = parseRankingsHtml(flightDoc(dehydratedObj(['other', 'x'], [{ a: 1 }])));
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有榜单/);
});

check('rank-08 data 不是数组时报字段漂移理由', () => {
  const r = parseRankingsHtml(flightDoc(dehydratedObj(['rankings', 'models', { view: 'week' }], { nope: true })));
  assert.equal(r.ok, false);
  assert.match(r.reason, /data 不是数组/);
});

check('rank-09 全是坏行（无 slug）时报没有可用行', () => {
  const r = parseRankingsHtml(flightDoc(dehydratedObj(['rankings', 'models', { view: 'week' }], [{ variant: 'standard' }, null])));
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有可用行/);
});

check('rank-10 真页夹具解析成功：≤20 行、slug 与 tokens 齐备、顺序即名次', () => {
  const r = parseRankingsHtml(weekHtml);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.view, 'week');
  assert.ok(r.rows.length >= 5 && r.rows.length <= 20, `行数 ${r.rows.length} 不在 5..20`);
  for (const row of r.rows) {
    assert.equal(typeof row.slug, 'string');
    assert.ok(row.slug.includes('/'), `slug 应含厂商前缀：${row.slug}`);
    assert.ok(Number.isFinite(row.tokens) && row.tokens >= 0);
  }
});

check('rank-11 tokens = prompt+completion 两项之和（不是单列 completion）', () => {
  const a = parseRankingsHtml(flightDoc(dehydratedObj(['rankings', 'models', { view: 'week' }],
    [{ date: 'd', model_permaslug: 'p/m', variant: 'standard', total_prompt_tokens: 100, total_completion_tokens: 23 }])));
  assert.equal(a.rows[0].tokens, 123);
});

check('rank-12 非 standard 变体被剔除（:batch 不单列）', () => {
  const a = parseRankingsHtml(flightDoc(dehydratedObj(['rankings', 'models', { view: 'week' }],
    [
      { model_permaslug: 'p/m', variant: 'standard', total_prompt_tokens: 1, total_completion_tokens: 1 },
      { model_permaslug: 'p/m', variant: 'standard', total_prompt_tokens: 2, total_completion_tokens: 2 },
      { model_permaslug: 'p/m', variant: 'beta', total_prompt_tokens: 99, total_completion_tokens: 99 },
      { model_permaslug: 'p/m', total_prompt_tokens: 5, total_completion_tokens: 5 },
    ])));
  assert.equal(a.rows.length, 3, 'standard 2 行 + 无 variant 字段 1 行（字段缺失不等于变体行）');
  assert.ok(a.rows.every((r) => r.slug === 'p/m'));
});

check('rank-13 多视图并存优先取 week', () => {
  const dayObj = dehydratedObj(['rankings', 'models', { view: 'day' }],
    [{ model_permaslug: 'day/only', total_prompt_tokens: 1, total_completion_tokens: 1 }]);
  const weekObj = dehydratedObj(['rankings', 'models', { view: 'week' }],
    [{ model_permaslug: 'week/only', total_prompt_tokens: 1, total_completion_tokens: 1 }]);
  const r = parseRankingsHtml(flightDoc(dayObj, weekObj));
  assert.equal(r.ok, true);
  assert.equal(r.view, 'week');
  assert.equal(r.rows[0].slug, 'week/only');
});

check('rank-14 没有 week 视图时回落第一个可用对象而不是失败', () => {
  const monthObj = dehydratedObj(['rankings', 'models', { view: 'month' }],
    [{ model_permaslug: 'month/only', total_prompt_tokens: 1, total_completion_tokens: 1 }]);
  const r = parseRankingsHtml(flightDoc(monthObj));
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].slug, 'month/only');
  assert.equal(r.view, 'month');
});

check('rank-15 超 20 行截到 TOP_N_MAX=20', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ model_permaslug: `p/m${i}`, total_prompt_tokens: 1, total_completion_tokens: 0 }));
  const r = parseRankingsHtml(flightDoc(dehydratedObj(['rankings', 'models', { view: 'week' }], many)));
  assert.equal(r.rows.length, 20);
});

check('rank-16 fetchRankings 命中榜单页 URL 且带 UA（非官方源的自我声明）', async () => {
  let captured;
  const fake = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, text: async () => weekHtml }; };
  const r = await fetchRankings({ fetchFn: fake });
  assert.equal(r.ok, true);
  assert.equal(captured.url, RANKINGS_URL);
  assert.ok(captured.opts.headers['User-Agent']);
});

check('rank-17 fetchRankings 非 2xx 给人话，解析失败透传 reason', async () => {
  const r403 = await fetchRankings({ fetchFn: async () => ({ ok: false, status: 403, text: async () => '' }) });
  assert.match(r403.reason, /403/);
  const rBad = await fetchRankings({ fetchFn: async () => ({ ok: true, status: 200, text: async () => emptyHtml }) });
  assert.equal(rBad.ok, false);
  assert.match(rBad.reason, /flight|结构/);
});

check('rank-18 fetchRankings 网络异常折成 reason 不上抛', async () => {
  const r = await fetchRankings({ fetchFn: async () => { throw new Error('socket hang up'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /socket hang up/);
});

check('rank-19 常驻标注文案在宿主侧单点定义（一份真相）', () => {
  assert.match(RANKINGS_SOURCE_NOTE, /非官方/);
  assert.match(RANKINGS_SOURCE_NOTE, /改版/);
});

check('rank-20 SSR 解析不再产出免费榜：free 行被剔除且响应里没有 freeRows 字段（v1.8 独立源）', () => {
  const r = parseRankingsHtml(flightDoc(dehydratedObj(['rankings', 'models', { view: 'week' }], [
    { model_permaslug: 'p/m', variant: 'standard', total_prompt_tokens: 1, total_completion_tokens: 1 },
    { model_permaslug: 'p/f', variant: 'free', variant_permaslug: 'p/f:free', total_prompt_tokens: 100, total_completion_tokens: 23 },
  ])));
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1, 'free 行不许占周榜名次');
  assert.equal('freeRows' in r, false, 'SSR 侧免费榜通道已拆：不许再带 freeRows');
});

check('rank-21 免费榜解析：筛 free、按 rankingMetricValue 降序、slug 带 :free、截到 20', () => {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push({ date: '2026-10-02 00:00:00', model_permaslug: `p/m${i}`, variant: 'free', variant_permaslug: `p/m${i}:free`, rankingMetricValue: 1000 - i });
  }
  rows.push({ date: '2026-10-02 00:00:00', model_permaslug: 'p/std', variant: 'standard', rankingMetricValue: 99999 });
  const r = parseFreeRankingsJson(JSON.stringify({ data: rows }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.rows.length, 20, '超 20 截到 TOP_N_MAX');
  assert.equal(r.rows[0].slug, 'p/m0:free');
  for (let i = 1; i < r.rows.length; i++) assert.ok(r.rows[i - 1].tokens >= r.rows[i].tokens, '必须降序');
  assert.ok(!r.rows.some((x) => x.slug === 'p/std'), 'standard 行不进免费榜');
});

check('rank-22 免费榜解析：同 slug 多行取 date 最新；metric 缺失回落 prompt+completion', () => {
  const r = parseFreeRankingsJson(JSON.stringify({ data: [
    { date: '2026-09-28 00:00:00', variant_permaslug: 'p/a:free', variant: 'free', rankingMetricValue: 500 },
    { date: '2026-10-02 00:00:00', variant_permaslug: 'p/a:free', variant: 'free', rankingMetricValue: 100 },
    { date: '2026-10-02 00:00:00', variant: 'free', model_permaslug: 'p/b', total_prompt_tokens: 60, total_completion_tokens: 40 },
    { date: '2026-10-02 00:00:00', variant: 'free', model_permaslug: 'p/c', rankingMetricValue: 120 },
  ] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows, [
    { slug: 'p/a:free', tokens: 100 },
    { slug: 'p/c', tokens: 120 },
    { slug: 'p/b', tokens: 100 },
  ].sort((a, b) => b.tokens - a.tokens), 'p/a 取最新日 100 而不是旧日 500；p/b 走回落口径');
});

check('rank-23 免费榜坏响应口径：非 JSON / data 非数组 / 无任何行才判坏', () => {
  assert.match(parseFreeRankingsJson('not json').reason, /JSON/);
  assert.match(parseFreeRankingsJson(JSON.stringify({ data: {} })).reason, /data 不是数组/);
  assert.match(parseFreeRankingsJson(JSON.stringify({ data: [{ variant: 'weird' }, null] })).reason, /没有可用行/);
  const onlyStd = parseFreeRankingsJson(JSON.stringify({ data: [{ variant: 'standard', model_permaslug: 'p/m' }] }));
  assert.equal(onlyStd.ok, true, '有 standard 行说明结构没坏：免费榜为空是数据本如此');
  assert.deepEqual(onlyStd.rows, []);
});

check('rank-24 真页夹具：免费榜成榜 ≥15 行、slug 带 :free、降序（独立源数据量够）', () => {
  const r = parseFreeRankingsJson(freeJson);
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.rows.length >= 15, `真页免费模型应有足够行数，实得 ${r.rows.length}`);
  for (const row of r.rows) assert.match(row.slug, /:free$/, `免费行 slug 应带 :free 后缀：${row.slug}`);
  for (let i = 1; i < r.rows.length; i++) assert.ok(r.rows[i - 1].tokens >= r.rows[i].tokens);
});

check('rank-25 fetchFreeRankings 命中独立端点且带 UA；非 2xx / 网络异常折成人话', async () => {
  let captured;
  const fake = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200, text: async () => freeJson }; };
  const r = await fetchFreeRankings({ fetchFn: fake });
  assert.equal(r.ok, true);
  assert.equal(captured.url, FREE_RANKINGS_URL);
  assert.ok(captured.opts.headers['User-Agent']);
  const r403 = await fetchFreeRankings({ fetchFn: async () => ({ ok: false, status: 403, text: async () => '' }) });
  assert.match(r403.reason, /403/);
  const rNet = await fetchFreeRankings({ fetchFn: async () => { throw new Error('socket hang up'); } });
  assert.equal(rNet.ok, false);
  assert.match(rNet.reason, /socket hang up/);
});

check('rank-26 免费榜来源文案在宿主单点定义且与新端点口径一致（一份真相）', () => {
  assert.match(FREE_RANKINGS_NOTE, /非官方/);
  assert.match(FREE_RANKINGS_NOTE, /失效/);
  assert.match(FREE_RANKINGS_NOTE, /周 token/);
});

await runAll('rankings');
