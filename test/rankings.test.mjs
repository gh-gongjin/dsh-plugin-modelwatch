import { check, runAll, assert, fixture } from './_helpers.mjs';
import {
  balancedObjectAt, unescapeChunks, parseRankingsHtml, fetchRankings, RANKINGS_URL, RANKINGS_SOURCE_NOTE,
} from '../lib/services/rankings.js';

const weekHtml = await fixture('rankings-week.html');
const emptyHtml = await fixture('rankings-empty.html');

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

await runAll('rankings');
