import { check, runAll, assert, fixtureJson } from './_helpers.mjs';
import {
  normalizeModels, newWithin, newThisWeek, newRecentForState, diffIds, fetchModels, MODELS_URL,
} from '../lib/services/models.js';

const NOW_MS = 1790730000000; // 2026-10-01 前后
const SEC_PER_DAY = 86400;

const fixture = await fixtureJson('models-sample.json');

check('models-01 normalizeModels 丢掉空 id / null / 字符串行', () => {
  const rows = normalizeModels(fixture);
  assert.ok(rows.every((r) => typeof r.id === 'string' && r.id));
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes(''), '空 id 不该进来');
});

check('models-02 normalizeModels 缺 name 回落 id', () => {
  const rows = normalizeModels(fixture);
  const noName = rows.find((r) => r.id === 'test/no-name');
  assert.equal(noName.name, 'test/no-name');
});

check('models-03 价格折成美元/1M，脏值归 undefined 不是 0', () => {
  const rows = normalizeModels(fixture);
  const nn = rows.find((r) => r.id === 'test/no-name');
  assert.equal(nn.priceInM, 3);   // 0.000003 * 1e6
  assert.equal(nn.priceOutM, 15); // 0.000015 * 1e6
  const bad = rows.find((r) => r.id === 'test/bad-created');
  assert.equal(bad.priceInM, undefined); // pricing.prompt = 'x'
  const zero = rows.find((r) => r.id === 'test/zero-price');
  assert.equal(zero.priceInM, 0);        // 显式免费是 0，与「未知」不同
});

check('models-04 created 非数字归 0（进不了任何新上窗口）', () => {
  const rows = normalizeModels(fixture);
  const bad = rows.find((r) => r.id === 'test/bad-created');
  assert.equal(bad.created, 0);
  assert.ok(!newThisWeek(rows, NOW_MS).some((r) => r.id === 'test/bad-created'));
});

check('models-05 data 不是数组时抛 BAD_SHAPE', () => {
  for (const j of [null, {}, { data: 'x' }, []]) {
    if (j && Array.isArray(j.data)) continue;
    assert.throws(() => normalizeModels(j), (e) => e.code === 'BAD_SHAPE');
  }
});

check('models-06 newWithin 恰在 7 天线上的不算新（开区间）', () => {
  const rows = [{ id: 'a', name: 'a', created: NOW_MS / 1000 - 7 * SEC_PER_DAY }];
  assert.equal(newWithin(rows, 7, NOW_MS).length, 0);
  rows[0].created = NOW_MS / 1000 - 7 * SEC_PER_DAY + 1;
  assert.equal(newWithin(rows, 7, NOW_MS).length, 1);
});

check('models-07 newWithin 按 created 降序', () => {
  const rows = [
    { id: 'old', name: 'old', created: NOW_MS / 1000 - 2 * SEC_PER_DAY },
    { id: 'new', name: 'new', created: NOW_MS / 1000 - 3600 },
    { id: 'mid', name: 'mid', created: NOW_MS / 1000 - SEC_PER_DAY },
  ];
  assert.deepEqual(newWithin(rows, 7, NOW_MS).map((r) => r.id), ['new', 'mid', 'old']);
});

check('models-08 newRecentForState 用 30 天窗口且按条数封顶（NEW_RECENT_CAP=60）', () => {
  const rows = [];
  for (let i = 0; i < 70; i++) rows.push({ id: `m${i}`, name: `m${i}`, created: NOW_MS / 1000 - i * 3600 });
  const kept = newRecentForState(rows, NOW_MS);
  assert.equal(kept.length, 60, '70 条都在 30 天窗内，应被封顶到 60');
  assert.equal(kept[0].id, 'm0', '保持 created 降序');
});

check('models-09 31 天前的行不进 30 天留档', () => {
  const rows = [{ id: 'ancient', name: 'ancient', created: NOW_MS / 1000 - 31 * SEC_PER_DAY }];
  assert.equal(newRecentForState(rows, NOW_MS).length, 0);
});

check('models-10 diffIds 首轮（prev=null）只报 firstRun 不产差异', () => {
  const d = diffIds(null, ['a', 'b']);
  assert.equal(d.firstRun, true);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

check('models-11 diffIds 双向差集', () => {
  const d = diffIds(['a', 'b', 'c'], ['b', 'c', 'd']);
  assert.deepEqual(d.added, ['d']);
  assert.deepEqual(d.removed, ['a']);
  assert.equal(d.firstRun, false);
});

check('models-12 fetchModels 走注入的 fetchFn 并命中官方 URL', async () => {
  let hitUrl = '';
  const fake = async (url) => { hitUrl = url; return { ok: true, json: async () => ({ data: [{ id: 'x', name: 'X', created: 1 }] }) }; };
  const r = await fetchModels({ fetchFn: fake });
  assert.equal(r.ok, true);
  assert.equal(hitUrl, MODELS_URL);
  assert.equal(r.rows[0].id, 'x');
});

check('models-13 fetchModels 非 2xx 归成人话且 ok:false', async () => {
  const r = await fetchModels({ fetchFn: async () => ({ ok: false, status: 503, json: async () => null }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /503/);
});

check('models-14 fetchModels 空列表按结构变化降级', async () => {
  const r = await fetchModels({ fetchFn: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /结构变化/);
});

check('models-15 fetchModels 网络异常不上抛，折成 error 字符串', async () => {
  const r = await fetchModels({ fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

check('models-16 fetchModels 超时（AbortError）报超时而非异常', async () => {
  const r = await fetchModels({ timeoutMs: 1, fetchFn: async (url, opts) => {
    const e = new Error('aborted'); e.name = 'AbortError';
    opts.signal.addEventListener?.('abort', () => {});
    throw e;
  } });
  assert.equal(r.ok, false);
  assert.match(r.error, /超时/);
});

await runAll('models');
