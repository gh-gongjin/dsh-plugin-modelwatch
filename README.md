# dsh-plugin-modelwatch

DSH（deepseek HARNESS）的 **OpenRouter 模型监控**插件：在侧边栏「插件」下方增加一个入口，盯两件事 —— **哪些模型新上了**、**本周热门榜怎么变**。变化只记录在本插件面板里，不推任何外部通知。

全程**只读 GET**：不带 key、不 POST 到 openrouter、不推外部通知。

**它是什么**

- **新上模型**：由清单的 `created` 时间戳直接算近 N 天（首轮建档就有东西可看，不依赖 diff），表格给出 name + slug / 上架时间 / 上下文 / 输入价 / 输出价
- **热门周榜**：按 token 用量的周榜，取前 `topN`（默认 15，可设 5~20），名次用金/银/铜徽标，量级条按榜首归一 —— 纯文本列看不出第 1 名与第 15 名差 20 倍
- **变化流水**：追加式时间线，事件种类为 `new_model / removed_model / top_enter / top_exit / top_move / source_error`（中文标签定义在宿主侧 `lib/domain.js`，界面只查表）；位次挪动 **≥3** 才记 `top_move`，周榜按天滚动更新，日间小幅挪动视为噪声不记
- **设置**：监测频率（1 / 6 / 12 / 24 小时）、榜单条数、事件保留条数（默认 500，范围 50~2000），外加一张只读的「运行环境」能力表

**它不是什么**

- 不是 OpenRouter 官方工具，与 openrouter.ai 无隶属关系；榜单数字是第三方口径的用量估算。
- 不做自动切换模型、不做调用、不做成本告警、不推通知。要通知请用宿主自己的机制，本插件不代作决定。

---

## 一个必须先说清的口径

热门周榜的来源是 `GET https://openrouter.ai/rankings` 的 **HTML 页面内嵌 react-query 水合数据**，属于**非官方接口**：解析路径是把 flight 字符串逐段反转义 → 取 `{"dehydratedAt"…}` 对象 → 找 `queryKey` 含 `"rankings","models"` 的那条 → `state.data`。**对方改版即失效。**

因此：

| 情况 | 面板表现 |
|---|---|
| 清单源（官方 API）失败 | 状态卡就地写「清单源不可用：<原因>」，保留上次快照 |
| 榜单源解析失败 | 榜单卡就地写「榜单源结构变化，解析失败」+ 保留上次榜单；卡标题旁**常驻**小字「来源：榜单页内嵌数据，非官方接口」 |
| 任一轮失败 | 原因进事件表 `kind:'source_error'`，让你能回看「哪天开始坏的」 |

源故障但留有旧数据时，表上方就地写「下面显示的是上次成功数据」—— 不把陈旧数据当实时数据念。

---

## 安装

### 方式 A：官方 CLI

```bash
dsh plugin --profile web add github:gh-gongjin/dsh-plugin-modelwatch
```

CLI 内部走 pnpm，需要 `pnpm` 在 PATH 里。本地目录同样可装：`dsh plugin --profile web add <本仓库的绝对路径>`。

### 方式 B：手工两步（不需要 pnpm）

1. 编辑 profile 的 `package.json`（默认 `~/.dsh/profiles/web/package.json`，Windows 为 `%USERPROFILE%\.dsh\profiles\web\package.json`）：

   - `dependencies` 增加：`"dsh-plugin-modelwatch": "link:<本仓库的绝对路径>"`
   - `dsh.profile.bundles` 数组末尾追加 `"dsh-plugin-modelwatch"`

2. 在 profile 的 `node_modules` 下建目录联接：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-plugin-modelwatch" `
     -Target "<本仓库的绝对路径>"
   ```

3. **重启 dsh**（宿主半边在启动时加载）。只改 `client.js` 的话刷新页面即可。

### 停用 / 卸载

临时停用：在 `~/.dsh/profiles/web/cordis.patch.yml` 里加

```yaml
- id: modelwatch
  disabled: true
```

---

## 界面

`页头 → 页签栏(5) → 当前面板 → 免责小字`，同一时刻只渲染一个面板。

页头左侧是标题 + 口径小字；右侧是数据源状态 pill（「数据源全部在位 / X 故障 / 部分源未就位 / 等待首帧」，悬停 `title` 落故障原因）+ 检查时刻与模型总数 + **唯一的主操作**「立即检查」（跑时禁用并显示「检查中…」）。一个功能只留一个入口，总览页不再重复放这颗按钮。

| 页签 | id | 计数徽标 | 内容 |
|---|---|---|---|
| 总览 | `overview` | — | 数据源状态 → 本周前三领奖台 → 新上 / 变化各取前几条（默认页） |
| 热门周榜 | `top` | 榜内行数 | 完整榜单表（`# / 模型 / 周 token / 量级 / 较上轮`） |
| 新上模型 | `new` | 近 N 天条数 | 新上表（5 列） |
| 变化记录 | `events` | 事件条数 | 时间线，限高内滚 |
| 设置 | `settings` | — | 三项偏好 + 只读运行环境 |

计数徽标只在有数据时渲染，数字**跟着快照走**，不写死。相对时间一律以**本轮检查时刻**为基准（`fmtAge(x, snap.at)`），不是浏览器当前时刻。

零浮层 toast：故障与状态说明各占一行落在触发它的那张卡内。

---

## 节拍与存储

默认 60 分钟一轮，档位是封闭集合 `[60, 360, 720, 1440]`；宿主 `ctx.timer` 优先，缺了退 `setInterval`（`unref` + dispose 显式清）。手动「立即检查」与定时走**同一条代码路径**，正在跑时返回 409 `CHECK_BUSY`。

存储走宿主 KV（domain `modelwatch`，三张表）：

- `state`（key=`latest`）：本轮快照 + 上轮榜单 + 近 30 天新模型行
- `events`（key=毫秒+序号）：追加式流水，超出 `keepEvents` 裁老
- `prefs`（key=`prefs`）：`{ intervalMin, topN, keepEvents }`，写入即生效（重挂定时器）

**KV 不可用时监控照跑**，但状态卡写「存储不可用：本轮变化无法留痕」，事件不落库 —— 不静默假装记录成功。

对外 HTTP 面挂在前缀 `/modelwatch` 下：`GET /api/snapshot`、`GET /api/stream`（SSE，首帧 snapshot、每轮 broadcast update）、`POST /api/check`、`GET /api/events`、`GET/POST /api/prefs`。**回环闸门只拦 POST**（本插件对系统零破坏面，GET 留给你从浏览器直接看数据）。

---

## 测试

零依赖：`node:assert/strict` + 自研 `check(name, fn)`，`node test/<x>.test.mjs` 直跑，无测试框架、无 npm script。用例名含「真机」者在 `SKIP_LOCAL=1` 下跳过并打印 SKIP。

```bash
for f in test/*.test.mjs; do node "$f"; done
```

当前读数（2026-10-02 本机 `SKIP_LOCAL=1`）：**119 过 / 0 挂 / 1 跳**。

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `api.test.mjs` | 20 | 路由表、回环闸门、SSE、错误码翻译 |
| `check.test.mjs` | 17 | 变化判定（diff / `created` 现算 / 位次阈值）、单飞与 409 |
| `client.test.mjs` | 21 | 页签骨架与顺序、计数跟快照走、版式契约（含金/银/铜徽标回落、`box-sizing` 根上必须在场、禁 `container-type`）、**原型同构断言** |
| `host-compat.test.mjs` | 11（+1 跳） | 缺 `storageDomain` / `timer` 时加载不抛、状态如实报 |
| `models.test.mjs` | 16 | 清单解析与规范化行 |
| `rankings.test.mjs` | 19 | flight 反转义 → 平衡花括号扫描 → `queryKey` 定位；改版即失败的降级 |
| `store.test.mjs` | 15 | 三张表读写语义、裁剪、clamp 用宿主常量不在客户端重写 |

一轮完整验收的读数：`SKIP_LOCAL=1` 下 **119 过 / 0 挂 / 1 跳**；变异电池 `tmp/mut_mw01.mjs` 38 条全红并按字节还原（`tmp/` 不入库，脚本按需在本地留存）。

---

## 目录结构

```
.
├── package.json            插件清单（dsh.bundle.patch / dsh.client），零第三方依赖
├── cordis.yml              bundle patch：- insert: [{id: modelwatch, name: dsh-plugin-modelwatch}]
├── index.js                宿主半边：能力探测、建服务、注路由、注入浏览器半边所需载荷
├── client.js               浏览器半边：侧边栏入口 + 主面板（React，零构建，CSS 以字符串注入）
├── lib/
│   ├── kv-schema.js          自造记录校验器（宿主只调 parse/safeParse）
│   ├── kv-records-base.js    domain 建域 / 写链 / 关停公共基座
│   ├── domain.js             事件 kind 标签、档位与边界常量的唯一来源
│   ├── stores.js             state / events / prefs 三张表
│   ├── services/             models（清单）、rankings（榜单解析）
│   ├── check.js              变化判定（宿主单点）
│   ├── caps.js               宿主能力探测
│   └── api.js                路由表 + SSE + 回环闸门
├── docs/design-spec.md       设计规格（含 §9 每轮验收台账与踩坑记录）
├── prototype/index.html      可点原型（与 client.js 同构，改设计先改它）
└── test/                     见上
```

## 挂载时的两个坑（踩过，写在这里省你时间）

1. **宿主半边不许 import `@deepseek-ai/*`**：`link:` 挂载会解析出第二份模块实例。本仓库零第三方依赖，schema 与 KV 基座都是自造的最小实现。
2. **`client.js` 里 ModuleLoader factory 必须 `return module.exports`**：宿主把 factory 的**返回值**当模块导出。写成 `return module;` 会在宿主启动时报 `invalid plugin, expect function or object with an "apply" method, received object` —— 这个错从 renderer 抛出、转成主进程 crash 日志，排查要去前端产物里找同文案。

另外版式上两条硬约束（由 `client.test.mjs` 钉住，别改回去）：`.mw-root` 必须**自己**带 `box-sizing:border-box`（`.mw-root *` 盖不到根自己，宿主前端没有任何通配 reset，漏了就整条右边界被裁出可视区）；**禁用 `container-type` / `@container`**，断点只用 `@media (max-width:1080px)`（在宿主 flex 主区下会把根算成 0 宽，整页塌成竖线）。

---

## 许可

MIT。见 `LICENSE`。

榜单是第三方页面的非官方接口，随时可能因改版失效；插件不会假装数据是实时准确的。
