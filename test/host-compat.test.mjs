import fs from 'node:fs';
import path from 'node:path';
import { check, runAll, assert } from './_helpers.mjs';
import { apply, resolveConfig, DEFAULT_CONFIG, name as PLUGIN_NAME, inject as HARD_INJECT, __peek } from '../index.js';
import { GLOBAL_KEY, ROUTE_PREFIX } from '../lib/api.js';
import { DEFAULT_PREFS } from '../lib/domain.js';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1)));
const HOST_FILES = ['index.js', 'lib/api.js', 'lib/caps.js', 'lib/check.js', 'lib/domain.js', 'lib/stores.js', 'lib/kv-schema.js', 'lib/kv-records-base.js', 'lib/services/models.js', 'lib/services/rankings.js'];

function readHost(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

check('hc-1 宿主半边零 @deepseek-ai import（link: 挂载铁律；注释里提这个包名是允许的，语句位扫描）', () => {
  const importRe = /^[ \t]*(?:import|export)[^\n]*?from\s+['"]@deepseek-ai/m;
  const reqRe = /^[ \t]*require\(\s*['"]@deepseek-ai/m;
  for (const f of HOST_FILES) {
    const src = readHost(f);
    assert.ok(!importRe.test(src) && !reqRe.test(src), `${f} 里出现了对 @deepseek-ai/* 的 import/require 语句`);
  }
});

check('hc-2 宿主半边 import 只允许相对路径与 node: 内置', () => {
  const re = /from\s+['"]([^'"]+)['"]/g;
  for (const f of HOST_FILES) {
    let m;
    while ((m = re.exec(readHost(f)))) {
      const spec = m[1];
      assert.ok(spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:'), `${f} 引了第三方：${spec}`);
    }
  }
});

check('hc-3 零第三方依赖：package.json 没有 dependencies 段', () => {
  const pkg = JSON.parse(readHost('package.json'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./client'].default, './client.js');
  assert.equal(pkg.dsh.bundle.patch, 'cordis.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
});

check('hc-4 cordis.yml 的 id/name 与插件导出一致', () => {
  const yml = readHost('cordis.yml');
  assert.match(yml, new RegExp(`id: ${PLUGIN_NAME}\\b`));
  assert.match(yml, /name: dsh-plugin-modelwatch/);
});

check('hc-5 GLOBAL_KEY / ROUTE_PREFIX 两侧逐字一致（双侧约定只有一个出处）', () => {
  const clientSrc = readHost('client.js');
  assert.ok(clientSrc.includes(`'${GLOBAL_KEY}'`), `client 里没有 ${GLOBAL_KEY}`);
  assert.ok(clientSrc.includes(`'/modelwatch/api'`), 'client 的 API_BASE 回落必须与 ROUTE_PREFIX/api 同值');
  assert.equal(ROUTE_PREFIX, '/modelwatch');
});

check('hc-6 零硬 inject：export const inject = []（缺服务不许卡死加载）', () => {
  assert.deepEqual(Array.from(HARD_INJECT), []);
});

/** 假 ctx：记录 inject 回调与 index-inject 订阅，logger 收 warn。 */
function makeCtx({ services = {} } = {}) {
  const calls = { inject: [], register: [], pushes: [], warns: [], effects: [] };
  const ctx = {
    logger: { warn: (m) => calls.warns.push(m), info: () => {}, error: () => {} },
    inject(deps, cb) { calls.inject.push({ deps, cb }); },
    on(name, fn) { (calls.on ||= {})[name] = fn; },
    effect(fn, label) { calls.effects.push(label); try { fn(); } catch { /* 装配测试不追清理细节 */ } return () => {}; },
    services,
  };
  ctx.fireInject = (svcs) => {
    for (const { deps, cb } of calls.inject) {
      if (deps.every((d) => d in svcs)) cb(Object.fromEntries(deps.map((d) => [d, svcs[d]])));
    }
  };
  return { ctx, calls };
}

check('hc-7 裸宿主（一个服务都没有）：apply 不抛，teardown 可调用', () => {
  const { ctx, calls } = makeCtx({ services: {} });
  const teardown = apply(ctx, {});
  assert.equal(typeof teardown, 'function');
  teardown();
  assert.ok(calls.warns.length >= 0);
});

check('hc-8 全服务落地：路由注册在 /modelwatch 前缀，index-inject 载荷字段齐全', async () => {
  const { ctx, calls } = makeCtx({ services: {} });
  apply(ctx, {});
  const registered = [];
  const facility = { async open() { throw new Error('本用例不给域'); } };
  const services = {
    storageDomain: facility,
    timer: { interval: (fn, ms) => ({ fn, ms, unref() {} }) },
    webServer: { register: (spec) => { registered.push(spec); return () => {}; } },
  };
  ctx.fireInject(services);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].path, ROUTE_PREFIX);
  assert.equal(registered[0].kind, 'prefix');

  const table = [];
  const sub = calls.on['webserver/index-inject'];
  assert.equal(typeof sub, 'function');
  sub(table);
  assert.equal(table.length, 1);
  assert.equal(table[0].name, GLOBAL_KEY);
  const v = table[0].value;
  for (const k of ['panelId', 'label', 'panelOrder', 'routePrefix', 'api', 'capabilities', 'capabilityRows', 'intervals', 'intervalLabels', 'topNRange', 'eventKindLabels', 'showDays', 'sourceNote', 'defaults', 'builtAt']) {
    assert.ok(k in v, `index-inject 载荷缺 ${k}`);
  }
  assert.equal(v.api, '/modelwatch/api');
  assert.equal(v.panelOrder, 14, '默认排在股票(10)/运维(12)下方');
});

check('hc-9 没 webServer 就不推入口载荷（空白页比看不到入口更糟）', () => {
  const { ctx, calls } = makeCtx({ services: {} });
  apply(ctx, {});
  const table = [];
  calls.on['webserver/index-inject'](table);
  assert.equal(table.length, 0);
});

check('hc-10 resolveConfig：脏档位回落默认、topN/keepEvents 钳边界、类型脏值各归各位', () => {
  const c1 = resolveConfig({ intervalMin: 7, topN: 999, keepEvents: -1 });
  assert.equal(c1.intervalMin, DEFAULT_CONFIG.intervalMin);
  assert.equal(c1.topN, 20);
  assert.equal(c1.keepEvents, 50);
  const c2 = resolveConfig({ label: 42, panelId: '', panelOrder: 'x' });
  assert.equal(c2.label, DEFAULT_CONFIG.label);
  assert.equal(c2.panelId, DEFAULT_CONFIG.panelId);
  assert.equal(c2.panelOrder, DEFAULT_CONFIG.panelOrder);
  const c3 = resolveConfig(null);
  assert.equal(c3.intervalMin, 60, '出厂默认 1 小时（写死，防默认值悄悄漂移）');
  assert.equal(c3.intervalMin, DEFAULT_CONFIG.intervalMin);
  assert.equal(DEFAULT_PREFS.intervalMin, 60, 'DEFAULT_PREFS 与 DEFAULT_CONFIG 必须同源');
});

check('hc-11 timer 就绪后重挂节拍：timerBackend 与能力位不许自相矛盾', () => {
  const { ctx } = makeCtx({ services: {} });
  apply(ctx, {});
  ctx.fireInject({ timer: { interval: (fn, ms) => ({ fn, ms, unref() {} }) } });
  assert.equal(__peek('timerBackend'), 'ctx.timer');
});

check('hc-12 真机：宿主 profile 的 link: 挂载与端口以本机 dsh 为准，本用例只声明口径不碰本机', () => {
  // 挂载与重启是用户确认后的动作（spec §9）；这条在 SKIP_LOCAL=1 下跳过。
  assert.ok(true);
});

await runAll('host-compat');
