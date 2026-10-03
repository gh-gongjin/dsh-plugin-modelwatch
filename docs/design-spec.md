# dsh-plugin-modelwatch 设计规格

监控 OpenRouter 的**新上模型**与**热门周榜**，变化只记录在本插件面板里（不推外部通知）。
2026-10-01 立项，口径由用户三项裁定：独立插件 / 热度=解析榜单页 / 只记录在面板。

## 0. 铁律（继承 sysops，逐条生效）

- 宿主半边零 `@deepseek-ai/*` import（link: 挂载会解析出第二份模块实例）。
- 零第三方依赖（node: 内置 + 浏览器原生 API 除外）。
- 零浮层 toast；错误与状态一律就地落卡（诚实降级：做不到就写明原因）。
- 一份真相：字段表/枚举/文案口径只写在宿主半边，浏览器半边只渲染。
- `lib/kv-schema.js`、`lib/kv-records-base.js` 是 sysops/stock 同名文件的**同源拷贝**：
  改动要三处对齐，不许各自漂移。
- UI 改动必须无头浏览器截图核对；「断言全绿 ≠ 符合原型」。

## 1. 数据源与红线

| 源 | 端点 | 性质 | 降级口径 |
|---|---|---|---|
| 模型清单 | `GET https://openrouter.ai/api/v1/models` | 官方公开 API | 失败 ⇒ 状态卡就地写「清单源不可用：<原因>」，保留上次快照 |
| 热门周榜 | `GET https://openrouter.ai/rankings`（HTML） | **非官方**：页面内嵌 react-query 水合数据，改版即失效 | 解析失败 ⇒ 榜单卡就地写「榜单源结构变化，解析失败」+ 保留上次榜单；卡片标题旁常驻小字「来源：榜单页内嵌数据，非官方接口」 |
| 免费榜单 | `GET https://openrouter.ai/api/frontend/v1/rankings/models?view=week`（JSON） | **非官方**：榜单页自己的前端读接口，接口变化即失效 | 失败 ⇒ 免费榜卡就地写「本轮榜单源故障：<原因>；下面显示的是上次成功数据」+ 保留上次免费榜；来源注常驻 |

- 全插件对网络是**只读 GET**（每轮三次），不带任何 key、不 POST 到 openrouter。
- 失败原因进事件表 `kind:'source_error'`，让用户能回看「哪天开始坏的」。
- 三个源**各自一道闸门**（`modelsOk` / `rankOk` / `freeOk`）：坏在哪一侧就只标注哪一侧，绝不连坐。

## 2. 热度口径

周榜 = flight 字符串逐段 `JSON.parse` 反转义 → 拼接 → 平衡花括号扫描取
`{"dehydratedAt"…}` 对象 → `queryKey` 含 `"rankings","models"` 的那条 → `state.data`（20 行/周，站点自己排的名次）。
取前 `topN`（默认 15）展示。`variant` 为 `standard`（或字段缺失）的行进周榜；`free` / `:batch` 等变体一律剔除 ——
**v1.8 起免费榜不再从这 20 行里筛**（真页里只有 1 行 free，成不了榜），改走 §1 的独立端点。

免费榜 = 端点 `data` 里 `variant === 'free'` 的行，一模型一行周汇总。名次口径 = `rankingMetricValue`
（= prompt+completion 周总量，2026-10-03 与 SSR 页逐值核对过；字段缺失才回落两项相加）。同一 slug 出现多行取
`date` 最新的一行。slug 取 `variant_permaslug`（带 `:free` 后缀）。截到 `TOP_N_MAX=20`，界面再按 `prefs.topN` 切片。
**端点的行序不是站点名次序**，所以免费榜按 token 量自己排 —— 来源注里如实写明这一点。

## 3. 变化判定（宿主单点）

- **新上**：本轮 id 集合 − 上轮 id 集合 ⇒ `new_model`；反向 ⇒ `removed_model`。首轮只建档不产事件（状态卡写「首次建档」）。
- **榜单**：本轮 top slug 序 vs 上轮 ⇒ `top_enter` / `top_exit`；位次挪动 ≥3 记 `top_move`。周榜按天滚动更新，日间位次挪动 <3 视为噪声，不记。
- **近 7 天新模型**不依赖 diff：直接由 `created` 时间戳算（首轮也有东西可看）。
- **免费榜**：`freeTop` 独立算 rank/delta（与上一轮免费榜比，同闸同规则），只落最新榜（`freeTop`/`prevFreeTop`），**不产任何流水事件** —— 变化记录只跟周榜，免费榜是展示面。坏轮冻结（`freeTop`/`prevFreeTop` 停在最后一次成功轮，不逐轮自我清空）；坏转好那一轮只记 `source_recover`，不补产积压 delta（拿不到公允上轮就不记账）。

## 4. 存储（domain `modelwatch`，三张表）

- `state`（key=`latest`）：`{ at, modelCount, modelIds[], top[], prevTop[], freeTop[], prevFreeTop[], newRecent[], modelsOk, rankOk, freeOk, ... }`。
  `modelIds` 只为 diff；`newRecent` 存近 30 天模型的规范化行（id/name/created/context/价格），界面直接渲染。
  `freeOk` / `freeError` / `freeTop` / `prevFreeTop` 是 v1.8 新增的**可选字段**：改动上线前写的旧档照读，快照里 `free.rows` 给空数组、`sources.free` 直说「还没跑过第一轮检查」。
- `events`（key=毫秒+序号）：追加式变更流水，`{ id, at, kind, slug, detail }`；保留 `keepEvents`（默认 500）条，超出裁老。
- `prefs`（key=`prefs`）：`{ intervalMin, topN, keepEvents }`，写入即生效（重挂定时器）。

KV 不可用 ⇒ 监控照跑，但状态卡写「存储不可用：本轮变化无法留痕」，事件不落库。

## 5. 节拍

默认 60 分钟一轮；档位封闭集合 `[60, 360, 720, 1440]`（设置页分段器）。宿主 `ctx.timer` 优先，缺了退 `setInterval`（unref + dispose 显式清）。手动「立即检查」走 `POST /modelwatch/api/check`，与定时同一条代码路径，正在跑时返回 409 `CHECK_BUSY`。

## 6. API 面（前缀 `/modelwatch`）

| 路由 | 答什么 |
|---|---|
| `GET /api/snapshot` | 全量快照（§8 字段表），首屏与 SSE 断线兜底共用 |
| `GET /api/stream` | SSE：首帧 `snapshot`，每轮检查完 broadcast `update`（载荷同 snapshot） |
| `POST /api/check` | 触发一轮检查；返回本轮 `{ at, produced }` |
| `GET /api/events?limit=` | 变更流水（默认 100，上限 500） |
| `GET/POST /api/prefs` | 读/写偏好（写整份读-并-写，同 sysops 口径） |

## 7. 面板（浏览器半边，页头 + 六页签）

版式于 2026-10-01 两轮重构：v1.1 废掉 2×2 等高网格，v1.3 改为**分页签**（均见 §9）。
结构：`Header → TabBar(6) → Panel(当前页签)`，同一时刻只渲染一个面板。

**页头**（`.mw-head`）：左＝标题；右＝数据源状态 pill（点 + 「数据源全部在位 / X故障 / 部分源未就位 / 等待首帧」，`title` 落故障原因与推流说明）+ 检查时刻与模型总数 + **唯一的主操作**「立即检查」（跑时禁用 + 「检查中…」）。
一个功能只留一个入口 —— 总览页不再重复放「立即检查」（v1.1 曾两处并存）。

**六个页签**（`TABS` 常量，标签与顺序写在 `client.js`；判定口径仍全部来自宿主载荷）：

| 页签 | id | 计数徽标 | 内容 |
|---|---|---|---|
| 总览 | `overview` | — | 数据源状态 → 本周前三 → 新上/变化各取前几条（默认页） |
| 热门周榜 | `top` | 榜内行数 | 完整榜单表 |
| 免费榜单 | `free` | 免费榜行数 | 独立源（§1 第三行）的免费变体周榜，与 `top` 同一张表组件、**各挂各的源闸门** |
| 新上模型 | `new` | 近 N 天条数 | 新上表（5 列） |
| 变化记录 | `events` | 事件条数 | 变化时间线 |
| 设置 | `settings` | — | 偏好三项 + 运行环境（只读） |

计数徽标只在有数据时渲染，数字**跟着快照走**，不写死。

1. **数据源状态**（总览首块，`.mw-srcrow`）：三个源各一行（点 + 源名 + 「在位 · 上次成功 <相对时间>」/「故障 · <原因原样念出>」）。存储不可用 / 推流断开 / 检查失败的说明各占一行落在本卡内（`.mw-notice`，故障用 `-err` 变体）。**无操作按钮**。
2. **本周前三**（`.mw-podium`，总览）：三张并排卡（`auto-fit, minmax(196px,1fr)`，窄了自动降为单列），金/银/铜徽标 + 「榜内第 N 名」+ slug + **大号 token 数**（20px）+ 较上轮变化。卡头右侧「完整榜单 →」切到 `top` 页签。
3. **总览下半区**（`.mw-cols` 1.6fr / 1fr）：左「近 N 天新上」、右「最近变化」，各放 3 / 4 条，卡头「全部 →」切到对应页签；空态各写一句实话。
4. **热门周榜**（`top`）：表格列 `# / 模型 / 周 token / 量级 / 较上轮`。名次走 **`RankBadge`**：1/2/3 = 金 `#e8b530` / 银 `#c3c9d2` / 铜 `#cf9a63` 实底徽标，第 4 名起回落中性描边；前三行整行淡金底（`.mw-tr-medal`）。**量级条**按榜首归一（`max(4%, round(tokens/max)·100%)`，4% 保底才看得见），前三名用同色系 —— 纯文本列看不出第 1 名与第 15 名差 20 倍。源故障但留有旧数据时，表上方就地写「下面显示的是上次成功数据」。
4b. **免费榜单**（`free`）：与 `top` 共用 `TopCard`（`board` 选数据 `snap.top` / `snap.free`，`srcKey` 选闸门 `sources.rankings` / `sources.free`）—— 故障横幅、量级条、名次徽标、`note` 吃宿主文案的口径完全一致，但**两榜各挂各的闸**：周榜源坏不许在免费榜页冒横幅，反之亦然（`srcKey` 由页签路由传下去，client-24 钉住）。空态写「免费榜源还没有成功返回过模型」。
5. **新上模型**（`new`）：表格（模型 name+slug 双行 / 上架 / 上下文 / 输入价 / 输出价），`created` 现算，与 diff 无关。首轮建档时表上方写「首轮建档：上架/下架对比从下一轮开始」。
6. **变化记录**（`events`）：时间线，kind 中文标签（表在宿主侧 `lib/domain.js` 的 `EVENT_KIND_LABELS`，界面只查表）+ 左圆点按 kind 着色；限高 420px 内滚。
7. **设置**（`settings`）：两张卡。「监测频率与容量」含间隔分段器 + 榜单条数 ± + **事件保留 ±**，卡头右侧就地写「已保存 · HH:MM」（零浮层）。「运行环境」只读列出 `capabilityRows` 三项能力（宿主快照原样渲染，不自己编）。

**相对时间基准**：一律 `fmtAge(x, snap.at)` —— 以**本轮检查时刻**为基准，不是浏览器当前时刻。
原型页的演示数字也必须按这个基准写，否则「原型 vs 真机」会看起来不一致（§9 v1.3 踩过）。

**版式硬约束**（由 `test/client.test.mjs` 的 client-20 / client-21 钉住）：

- 两栏 `.mw-cols` 必须 `align-items:start` —— 卡片按内容自然高度，**不做等高拉伸**（等高会把短卡截成一大片空白，这是 v1 的原始缺陷）。
- **禁止 `container-type` / `@container`，断点只用 `@media (max-width:1080px)`**（与 stock 插件对齐）。理由见 §9 v1.2 的真机事故：inline 轴 size containment 会让根容器宽度不再由内容撑开，宿主 flex 主区下直接算成 0 宽。
- `.mw-root` 必须 `width:100%`（宽度不能由内容决定）+ **必须自己带 `box-sizing:border-box`** + `max-height:100vh;overflow-y:auto`（宿主面板容器 `overflow:hidden`，内容超视口会被裁，得自管滚动 —— 同 stock）。
  **宿主 web 前端的 CSS 里没有任何通配 `box-sizing`**（2026-10-02 核过 app.asar 里 `index-*.css` / `vendor-*.css` 两份产物，0 条），而 `.mw-root *` **盖不到根自己** ⇒ 根会是 content-box，`width:100%` 只算内容宽，再加左右各 20px padding，**外框比面板宽 40px**，右侧那一截（页头主按钮、卡头右端计数、榜单右侧列）被顶到可视区外。兄弟插件（stock `.sa-root` / sysops `.so-root`）都把 `box-sizing` 写在根规则里 —— 照抄。见 §9 v1.4。
  同理**原型页不许用全局 `*{box-sizing:border-box}` 重置**：那会把这个 bug 在原型里完全藏住。
- token 名必须用宿主真名 `--dsw-alias-*`：`label-primary` / `label-secondary` / `label-tertiary` / `bg-base` / `bg-layer-2` / `bg-layer-3` / `border-l1` / `border-l2` / `state-business-primary`。写错名字不会报错，只会让宿主主题永远不生效。
- `.mw-setrow` 会挂在 `.mw-card-b`（column 容器）上，必须显式写回 `flex-direction:row`，否则整行竖排。
- 卡头 `.mw-card-h` 走软底 + 下边线，表头 sticky 用卡片白底 —— 两层底色相邻要分开，别糊成一片。
- 卡头里「计数 + 链接」必须贴靠收在右侧：`.mw-card-h .mw-card-n+.mw-link{margin-left:2px}`。两个 `margin-left:auto` 会把空白对半分，计数飘到卡头中间。
- **原型（`prototype/index.html`）与 `client.js` 必须同构**：页签 id 逐一对应、样式标记逐个在场，由 client-20 / client-21 断言。原型落后于实现 = 用户看到「实际效果跟你原型不一样」。
- **设置里每个被存储的偏好字段都必须有改它的入口**（`intervalMin` / `topN` / `keepEvents`），取值边界只从宿主载荷读（`topNRange` / `keepEventsRange`），客户端不许再写一份。

无浮层；数字 tabular-nums；断点继承 stock 插件 §5.1 token。

## 8. 快照字段表（一份真相，宿主侧定义）

```
{ at, caps, capabilityRows, prefs,
  sources: { models: { ok, error, checkedAt },
             rankings: { ok, error, checkedAt, unofficial: true, note },
             free: { ok, error, checkedAt, unofficial: true, note } },
  models: { count, newThisWeek: [row], baseline: bool },
  top: { rows: [ { rank, slug, tokens, delta } ], prev: [slug], note },
  free: { rows: [ { rank, slug, tokens, delta } ], days: 7, note },  // v1.8 独立源；slug 带 :free 后缀
  events: [ { id, at, kind, slug, detail } ] }
```

`state` 表里与免费榜相关的键：`freeTop[]` / `prevFreeTop[]` / `freeOk` / `freeError`，全部是**可选字段**
（旧档照读，见 §4）。页头 pill 的三源名册（`清单源 / 周榜源 / 免费榜源`）在 `client.js` 的 `Header` 里，
坏因与「部分源未就位」都从 `sources` 现算。

## 9. 验收台账（每轮追加 §9.x）

- v1（2026-10-01）：脚手架 + 宿主 + 面板 + 原型 + 测试。挂载与真机复核**需要用户确认后**才动 profile 与重启宿主；真机探针只允许 GET（见 sysops 血案记录）。
- v1 本地验收（2026-10-01）：
  - 测试：SKIP_LOCAL=1 全套 117 过 / 0 挂 / 1 跳（跳的是「真机」用例）——api 20、check 17、client 19、host-compat 11+1跳、models 16、rankings 19、store 15。
  - 变异电池 `tmp/mut_mw01.mjs`：38 条全红（首轮 5 条漏网 CK-3/CK-8/ST-3/AP-5/CL-2，已补 check-17、store-15、api-20、client-04 K 档后复跑全抓）；跑完按字节还原、六文件 sha 一致。
  - 原型截图核对：`prototype/index.html` 经无头 Chrome 出图（tmp/mw-prototype2.png），四卡布局、故障横幅+上次数据标注、新见/▲/▼/—、设置分段均正常；顺手修掉演示数据「5 个 vs 3 行」的自相矛盾。
- v1 真机首轮（2026-10-01）：挂载后宿主 web-boot 抛 `invalid plugin, expect function or object with an "apply" method, received object`。根因：client.js 的 ModuleLoader factory 结尾写了 `return module;`，宿主吃的是 factory **返回值**当模块导出（sysops 是 `return module.exports;`），外层自然找不到 apply。该错误从 renderer 抛出、经 `DESKTOP_IPC.bootFailed` 转成主进程 crash 日志，排查时要先去 `dsh-web-frontend` 的 assets 里找同文案。已修 + client.test 沙箱改为与宿主同口径（返回值即导出）+ 变异电池加 CL-7 钉死。
- v1.6 免费榜单 tab（2026-10-03）：
  - 数据：免费行取自**同一榜单源** week 数据里 `variant=free` 的行（slug 用 `variant_permaslug`，带 `:free` 后缀），零新增出网请求。真页探针（`F:/dsh-plugins/tmp/peek-views.mjs`，2026-10-03）核实榜单页只水合 `week/apps/benchmarks` 三个 queryKey，**没有独立免费榜数据段** —— 免费榜只能从周榜行里分。
  - 宿主：`parseRankingsHtml` 增返 `freeRows`（周榜满 20 不再 break，防混排漏收）；`check` 为免费榜独立算 rank/delta，落 `freeTop`/`prevFreeTop`（domain 可选字段，上线前的旧档照读照写）；快照增 `free`（rows 按 prefs.topN 切片，来源注 `FREE_RANKINGS_NOTE` 宿主单点）。免费榜进/出/挪位**不进流水**。
  - 界面：第 3 个页签 `free`；`TopCard` 泛化成 `board` 参数，周榜/免费榜同表同降级；页签计数跟快照走。
  - 验收：全套 130 过 / 0 挂（api 21、check 19、client 22、host-compat 12、models 16、rankings 24、store 16）；变异电池加 10 条（RK-5..7 / CK-9..10 / AP-9..10 / CL-8..10），49 条全红、六文件 sha 还原一致；原型截图核对 `tmp/tab-free.png`（金银铜 + 量级条 + 故障横幅 + 来源注）与 `tmp/tab-top2.png`（周榜回归）。
  - 顺手清掉两条陈年漏网：**CK-4**（摘 busy 闸）原本把 check 套件挂成 unsettled await —— check-09 里第二轮 `svc.run()` 与假 gate 互等死锁，连 FAIL 都吐不出、电池误判绿；改成「先取第二轮 promise → 放闸 → 再断言」。**ST-3**（patch 丢读-并-写）重新漏网是因为 store-15 的"已存值"60 恰好等于 v1.5 起的出厂默认 —— 教训：**读-并-写用例的首写值必须选非默认档**（已改 720）。
- v1.8 免费榜换成独立源（2026-10-03）：用户反馈「现在免费榜单只有一个，免费榜单能单独抓取吗，不跟热门周榜一起，不然数据太少了」。
  - 根因：v1.6 的免费行取自榜单页 SSR 的那 **20 行**周榜，真页里只有 1 行是 `:free` 变体 —— 不是抓取漏了，是数据本就只有这么多。
  - 换源：改抓 `GET https://openrouter.ai/api/frontend/v1/rankings/models?view=week`（榜单页自己的前端读接口，仍是**只读 GET、无 key**）。同一份周数据里 free 变体有 **27 个模型**，界面按 `prefs.topN` 切 15 条展示。真页响应留在 `test/fixtures/free-week.json`（27 free + 12 standard 的裁剪夹具）。
  - 口径：名次 = `rankingMetricValue`（= prompt+completion 周总量，2026-10-03 与 SSR 页逐值核对过一致；字段缺失才回落两项相加）；同 slug 多行取 `date` 最新；slug 取 `variant_permaslug`（带 `:free`）。**端点行序不是站点名次序**，所以免费榜按 token 量自己排 —— 这一点写进 `FREE_RANKINGS_NOTE`，界面上的来源注就是这句话（宿主单点）。
  - 为什么热门周榜不跟着换：端点按 token 总量排出来的名次与站点显示的名次**不一致**（站点用自己的算法），而 SSR 那 20 行就是页面上看到的榜 —— 保住站点语义，只有免费榜换源。
  - 宿主：`parseRankingsHtml` 不再产 `freeRows`（SSR 侧免费榜通道拆掉，rank-20 钉）；新增 `parseFreeRankingsJson` + `fetchFreeRankings`；`check` 变成**三源并行、三道独立闸门**（`modelsOk`/`rankOk`/`freeOk`，各自 flip-only 记 `source_error`、坏转好记 `source_recover`、坏轮冻结旧榜、坏转好那轮不补产积压 delta）；`state` 新增可选字段 `freeOk`/`freeError`（旧档照读，快照 `free.rows` 给空数组、`sources.free` 直说「还没跑过第一轮检查」）。免费榜仍然**不产任何流水事件**。
  - 界面：`TopCard` 加 `srcKey` 参数 —— 周榜挂 `sources.rankings`、免费榜挂 `sources.free`，两榜各挂各的横幅；状态卡加第三行「免费榜单（非官方源）」；页头 pill 的三源名册加 `免费榜源`。
  - 验收：全套 **135 过 / 0 挂 / 1 跳**（api 21、check 21、client 24、host-compat 11+1跳、models 16、rankings 26、store 16）；变异电池扩到 **63 条全红**（新增 RK-5..11 免费榜解析 7 条、CK-11..14 免费榜闸门 4 条、AP-11/12、CL-11..14），六文件 sha 逐字节还原 `allRestored:true`；无头 Chrome 截图核对 `tmp/v18-free.png`（15 行真数据、无横幅、来源注新口径）、`tmp/v18-overview.png`（三源三行，周榜故障不连坐免费榜）。
  - 本轮踩到的两处（都已修 + 已定性）：
    - **假绿来自路由没被测到**：CL-12（免费榜路由漏传 `srcKey`）第一轮是绿的 —— client-22 手搓 `freeProps` 直接渲染 `TopCard`，绕过了 `ModelwatchPage` 的 tab→组件路由。补 client-24：给测试沙箱的 `useState` 加初始值注入（`opts.tab` / `opts.snap`，`useState(null)`/`useState('overview')` 各只有一处）+ `mount()` 递归展开函数组件（fake react 不调组件），逼路由本身进断言。**教训：凡是"参数由上层传下来"的组件契约，必须至少有一条用例走真实调用点。**
    - **变异电池会自己骗自己**：client-24 一度是挂的状态，而整轮电池把 CL-11/CL-12 都报成"红（被抓住）" —— 套件本身在红时，任何改动都"被抓"。已把「先全套绿、再跑电池」定成顺序，且电池输出里的 `pass/fail` 读数要逐条看。**另外发现一次 Windows 写盘与子进程抢读导致的假绿**（同一变异单独重跑就变红）：整轮跑完必须对可疑的绿条目 `MUT_ONLY=<id>` 复跑一遍再定性。
- v1.7 文案瘦身（2026-10-03）：用户贴真机截图圈掉页尾免责小字，「页面上不必要的文案都去掉」。删：页尾 disclaimer、页头口径小字（「OpenRouter 新上模型与热门/免费周榜 · 全程只读 GET」）、数据源卡头与页头重复的「检查于 X · 模型总数 N」、新上卡「口径：官方清单 API…」脚注、榜单来源注后面的「名次差按…新见=…」图例长句、事件空态的建档解释（留「还没有记录」）。**保留**：非官方源标注与来源注（诚实标注铁律）、故障横幅、状态行「在位/故障」、设置页「改动即生效」等功能性文案。改动面：`client.js`（组件 + CSS 常量）、`prototype/index.html`（同构同步）。验收：全套 129 过 / 0 挂 / 1 跳（api 21、check 19、client 22、host-compat 11+1跳、models 16、rankings 24、store 16）；变异电池 49 条全红、六文件 sha 还原一致；截图核对 `tmp/copy-overview.png`、`tmp/copy-new.png`、`tmp/copy-top.png`。
- v1.1 版式重构（2026-10-01）：用户贴真机截图反馈「页面布局有点丑」。诊断出三处：①2×2 等高网格把「状态」卡拉到与右列表格同高，卡内空出约 150px；②周榜（主内容，15 行）被塞进半宽栏，slug 被压；③周榜不限高把页面拉到 1600px+，右栏还是一张只有 1 条记录的矮卡。改法见 §7 —— 状态压成横条（251px → 53px）、周榜进主栏、`align-items:start` 取消等高拉伸、断点改容器查询。改动面：`client.js`（CSS 常量整段 + 五个组件结构 + 页面骨架）、`prototype/index.html`（同构重写 + 演示数据补满到 6/15/6 行）。
  - 验收：client-20 版式契约 5 条，**含两条反向验证**（去掉 `align-items:start`、去掉 `.mw-setrow` 的 `flex-direction:row`，均按要求变红，还原后恢复绿）。
  - 离线预览页 `tmp/preview.html`（走 `apply` 真路径 + mini-react 跑真组件）两档核对：1400px 得双列 `805 / 503`，900px 得单列 `838`（容器查询生效）；5 张卡高 53/630/257/392/94；15 行周榜、6 行新上、6 条事件；文档 `scrollWidth == 视口`、超宽元素 0。
  - 全套 118 过 / 0 挂 / 1 跳。
  - 顺带踩到并已记录：`.mw-setrow` 与 `.mw-card-b` 同类名冲突导致设置行竖排；headless 截图窗口高度不足时会截到内容中部（看着像"卡被裁"，实为截图窗口比内容矮）。
- v1.2 真机事故：**整页塌成"每张卡一条竖线"**（2026-10-01）。
  - 现象：用户重启宿主后贴截图 —— 主区全空，只有"模型监控"四个字逐字竖排，每张卡是一条 1px 竖线。
  - 根因：v1.1 为了"断点跟随容器宽度"给 `.mw-root` 加了 `container-type:inline-size` + `@container`。该属性施加 **inline 轴 size containment** ⇒ 元素宽度**不再由内容撑开**；宿主主区是 flex、`.mw-root` 又是 `flex:0 1 auto`（宽度按内容算）⇒ 宽度算成 **0**，里面所有 flex/grid 子项跟着塌。
  - 复现：离线预览页加 `#flexhost` 模式（把 `#root` 设成 `display:flex`）后 100% 复现 —— 5 张卡宽 **2px**、高 439/1947/461/672/427，与真机截图一致。
  - 修法：去掉 `container-type`，断点改回 `@media (max-width:1080px)`；`.mw-root` 补 `width:100%` 与 `max-height:100vh;overflow-y:auto`；顺带把 token 名从自造的 `--dsw-alias-text/-panel/-border` 改成宿主真名（对齐 stock/sysops）。
  - 断言：client-20 加两条负向断言（`!/container-type/`、`!/@container/`，原型同样禁），已反向验证（把 `container-type` 塞回去 → 变红）。
  - **教训**：容器查询在"宽度由内容决定"的父级下会把元素算成 0 宽，而这个坑在独立预览页里看不见（预览页 `#root` 是 block，宽度确定）。**凡是兄弟插件不用、而我想"改进"的 CSS 特性，先在模拟宿主约束下验一遍再上真机。**
- v1.3 分页签重做（2026-10-01）：用户贴真机截图反馈「实际效果跟你原型不一样，页面重新设计一下，可以多个 tab 页，不用局限现在的页面布局，做得好看一点，比如前 1、2、3 名用不同的徽标标识等等」。
  - 判断：不是 bug 而是版式跟不上信息量 —— v1.1 把 5 块竖着堆成一长条，周榜 15 行、事件、新上互相抢纵向空间；原型也确实停在 v1.1 之后再没同步过（**两条都要还**）。
  - 改法：页头收敛成一个主操作 + 状态 pill；5 个页签（计数跟着快照走）；总览做「状态 → 前三领奖台 → 新上/变化各取前几条 + 全部 →」；榜单表加金/银/铜 `RankBadge` + 按榜首归一的量级条 + 前三行淡金底；设置补上 `keepEvents` 入口（此前是「存了却没控件能改」的字段）+ 只读的「运行环境」卡。
  - 改动面：`client.js`（CSS 常量尾部 + 新增 `TABS`/`Header`/`TabBar`/`RankBadge`/`MiniList`/`Podium`/`OverviewTab`，重写 `StatusCard`/`TopCard`/`SettingsBar`/`ModelwatchPage`）、`prototype/index.html`（整页重写为**可切换页签**的同构 spec 页 + `#tab-x` 遥控）、`lib/domain.js`（`KEEP_EVENTS_MIN/MAX/STEP` 单一来源）、`lib/stores.js`（clamp 改用同一份常量）、`index.js`（inject 载荷加 `keepEventsRange`）。
  - 验收：
    - client-21 新增：5 个页签 id 与顺序、页签栏中文标签、计数跟着 fixture 走（周榜 2 行 ⇒ 断言 `热门周榜\|2`）、`RankBadge` 1/3 走金银铜而 9 回落中性、默认落 `overview`、三个偏好字段都有入口、取值边界不许在客户端再写一份。
    - client-20 追加**原型同构断言**：原型必须含 `.mw-tabs` / `.mw-panel{` / `.mw-podium` / `.mw-bar` / `.mw-rank-1` / `.mw-rank-3` / `.mw-setlabel` / `mw-panel[hidden]` / 计数链接贴靠规则；client-21 追加 5 个 `data-tab` 与 5 个 `id="p-*"` 面板逐一在场。**已反向验证**（把原型里的 `mw-podium` 批量改名 ⇒ client-20 变红，还原后恢复绿）。
    - 逐页视觉核对（无头 Chrome，`--window-size=1400,1200`）：`prototype/index.html#tab-{overview,top,new,events,settings}` 与 `tmp/preview.html#flexhost-tab-*-shot`（走 `apply` 真路径 + mini-react + flex 宿主约束）**五页逐页对齐**：领奖台 3 张、徽标色 `rgb(232,181,48) / rgb(195,201,210) / rgb(207,154,99)`、量级条按榜首归一、三个计数 15/6/6、设置三行偏好 + 三行能力齐全。
    - 窄视口：512px 下 `.mw-cols` 列模板 = 单列 `472px`，`文档 scrollWidth == 视口`，超宽元素 0。
    - 全套 119 过 / 0 挂 / 1 跳（api 20、check 17、client 21、host-compat 11+1跳、models 16、rankings 19、store 15）。
  - 本轮踩到的两处（都已修 + 已定性）：
    - 原型页的演示**相对时间**写成了「以浏览器当前时刻为基准」（`16 分钟前`），而引擎是 `fmtAge(x, snap.at)`（以本轮检查时刻为基准，同一份数据渲染成 `11 分钟前`）。这不是 bug，是原型数字口径错了 —— 原型已按引擎基准改写，并把这句口径写进 §7。
    - 卡头里 `.mw-card-n` 与 `.mw-link` 都带 `margin-left:auto`，两个 auto 会把空白对半分 ⇒ 计数从「贴右」飘到卡头中间。加 `.mw-card-h .mw-card-n+.mw-link{margin-left:2px}` 收口，原型与 client.js 两处同步。
  - 首次尝试把 5 个面板**平铺副本**塞进原型页做「一页看全」，随即删掉：真机同一时刻只渲染一个面板，平铺副本会被读成「重复渲染」。
- v1.4 右侧被裁（2026-10-02）：用户贴真机截图「旁边显示不出来了」。
  - 现象：页头「立即检查」按钮右侧被切、状态卡头「检查于 刚刚 · 模型总数 464」末尾截断、「完整榜单 →」与「最近变化」的时间列看不到 —— 一整条右边界外的东西都看不见。
  - **先纠正量尺**：截图是 **1920×1232**，我第一眼拿缩略图当 1:1 读，尺寸全错。真机是 125% 显示缩放 ⇒ CSS 视口 ≈1536、侧栏 ≈336、面板 ≈1200，所以 `@media (max-width:1080px)` 不命中（两栏还在）是对的。
  - 定位手法（可复用）：写 PNG 解码器（`node:zlib` inflate + 反 filter）量彩色像素 —— 领奖台三张卡有金/银/铜描边，直接扫出列边界：金卡 472→946、银卡 962→1437、铜卡 1453→**越出 1920**。反推 root 内容宽 ≈1190 CSS px ≈ 面板宽，**外框比面板宽 40px**（正好是左右 padding 之和）。
  - **根因**：宿主 web 前端 CSS 里**没有任何通配 `box-sizing`**（核过 `app.asar` 里 `index-*.css` / `vendor-*.css`），而 `client.js` 只写了 `.mw-root *{box-sizing:border-box}` —— **`.mw-root *` 盖不到 `.mw-root` 自己** ⇒ 根是 content-box，`width:100%` 只算内容宽，左右各 20px padding 被算到外面。兄弟插件（stock `.sa-root` / sysops `.so-root`）都把 `box-sizing:border-box` 写在根规则里，只有本项目漏了。
  - 为什么之前所有自检都没抓到：**预览页的 `#flexhost` 模式把 `#root` 设成 `display:flex`，`.mw-root` 变成 flex item，默认 `flex-shrink:1` 会在容器不足时把它压回容器宽** —— 溢出一收缩就没了；原型页有全局 `*{box-sizing:border-box}` 重置，也把根盖住了。两条路都刚好把 bug 藏住。
  - 修法：`.mw-root` 补 `box-sizing:border-box`；**原型页去掉全局 `*{box-sizing:border-box}` 重置**，改成与 client.js 同选择器结构（根自己带 + `.mw-root *`）；预览页新增 `#hostsim` 模式（侧栏 + `_pane(column,overflow:hidden)` + `_paneBody(block,overflow:auto)`，即真机祖先链）并加**自动判定**：根 box-sizing 非 border-box、根宽超过父内容盒、或溢出视口任一成立就打印 `!! 根容器尺寸异常`。
  - 验收：
    - 断言：client-20 加两条正向 + 两条负向 —— `.mw-root{…box-sizing:border-box` 必须在场，「不许用全局通配 box-sizing 兜底」在 client.js 与原型两侧都断言。**已反向验证**（抽掉根的 border-box ⇒ 变红，还原后绿）。
    - `#hostsim` 三档实测：1400 → 根 958 溢出 0；1536（真机等效）→ 根 1094 溢出 0；1920 → 根 1320（`max-width` 生效）溢出 −79。修前同窗口 1400 是「根 998 塞进 958 ⇒ 溢出 40px」。
    - 诊断自动判定也做了反向验证：临时抽掉 border-box ⇒ 打印 `!! 根容器尺寸异常：box-sizing=content-box 根宽=998 父内容盒=958 ⇒ 根比父宽 40px ⇒ 溢出视口 40px`。
    - 全套 119 过 / 0 挂 / 1 跳。
  - **教训**：①`X *` 选择器**永远盖不到 X 自己** —— 用到 `box-sizing` / `overflow` 这类"必须根上生效"的属性时，先确认根自己被覆盖了；②**预览要还原祖先链，不是只还原容器类型**：flex item 会收缩、块级子元素不会，前者会吃掉 overflow 类 bug；③**原型的全局重置是把双刃剑**，它让原型比真机"更正确"，于是差异看不见 —— 原型要与实现同选择器结构，才能当真机用。
