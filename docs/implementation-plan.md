# dsh-plugin-modelwatch 实现计划

口径见 `docs/design-spec.md`。测试文化继承 sysops：无框架，`node test/<x>.test.mjs` 直跑；
用例名含「真机」的在 `SKIP_LOCAL=1` 下跳过；每轮改动留变异电池 `tmp/mut_mwXX.mjs`。

| Task | 内容 | 验收 |
|---|---|---|
| T1 | 脚手架：package.json / cordis.yml / lib/kv-schema.js / lib/kv-records-base.js（同源拷贝） | host-compat 静态扫描零 `@deepseek-ai` import |
| T2 | `lib/domain.js`：域与三表 schema + EVENT_KIND_LABELS + 档位集合 | store 套件 |
| T3 | `lib/services/models.js`：normalize + newThisWeek + diff（纯函数，fetchFn 注入） | models 套件（夹具 JSON） |
| T4 | `lib/services/rankings.js`：flight 反转义 + 平衡扫描 + 周榜提取（纯函数 parseRankingsHtml） | rankings 套件（裁剪版真夹具；结构坏→带原因的失败对象，不抛） |
| T5 | `lib/check.js`：一轮检查编排（读旧 state→两源→diff→写 events/state→回调广播）；busy 单闸 | check 套件（假 fetch/假 store） |
| T6 | `lib/prefs-store.js` + 定时器装配（index.js：caps、teardown、index-inject） | host-compat 装配同形用例 |
| T7 | `lib/api.js`：路由表 + openSse/hub + statusFor | api 套件 |
| T8 | `client.js` 四卡 + SSE + 就地降级；`prototype/index.html` 同构 | client 纯函数套件 + 无头截图核对 |
| T9 | 全量跑测 + 变异电池 + 真机挂载（需用户确认 profile 改动与宿主重启） | 全绿 + 截图 |
