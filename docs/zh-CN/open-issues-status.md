# 未关闭 Issue 现状汇总

> 基线：`v1.1.0`（tag `2205ba19`）+ `1b962154`（倍率修正，当时未推送）
> 整理日期：2026-09-11
> 范围：`techysy/10router` 的全部 open issue，逐项对照当前代码核查
> 用途：把 issue 里的分析固化进仓库（不依赖 GitHub 评论区），供后续排期时直接取用

---

## 0. 总览

| Issue | 标题 | 结论 | 状态 |
|---|---|---|---|
| [#12](https://github.com/techysy/10router/issues/12) | `GET /v1/models` 500 `jsonCatalog is not defined`（v1.0.8） | 代码侧早已修复，报告人拉到的是**唯一未带修正的 1.0.8 产物**（ghcr 镜像） | ✅ **已关闭** |
| [#9](https://github.com/techysy/10router/issues/9) | 安全审计反馈（v1.0.7）11 项清单 | ✅ 1 项已修 / 🟡 4 项部分 / ❌ 6 项未修 | ⏸ **保持 open**（追踪单） |
| [#10](https://github.com/techysy/10router/issues/10) | 内容过滤（`finish_reason: "sensitive"`、0 输出）时重试 combo fallback | 诊断正确，**未实现**；设计要点见 §3 | ⏸ **保持 open**（功能请求） |
| [#13](https://github.com/techysy/10router/issues/13) | 小米桌面版专属模型未登录时抛原始 502，且被误判为限流进 30s 冷却 | 根因链已逐环验证；需错误分类 + 中文提示 + 事前徽章三件事 | ⏸ **open**（下版待办，见 §4） |

**为什么 #9 / #10 / #13 不关**：#9 有 2 项高危（#2 凭据明文、#3 默认口令）确实未动，关掉等于把问题埋掉；#10 是可实现但尚未实现的功能请求，留作 backlog 条目；#13 是新记的下版待办。

---

## 1. Issue #12 —— 代码早已修，坏的是产物

### 真因

`jsonCatalog` 这个悬空引用来自 `686b1217`（JSON 目录下线重构）的残留，修复提交是 **`ec4e70c7`**（2026-09-10）。但 **v1.0.8 的三份产物构建自不同 commit**：

| 产物 | 构建自 | 是否含 `ec4e70c7` |
|---|---|---|
| fpk ×4 | `eeeb4b73` | ✅ |
| Windows 安装器 ×4 | `9ee15812` | ✅ |
| **ghcr Docker 镜像** | **`1e16a748`** | ❌ |

报告人用的是 ghcr 镜像，所以命中了这个 bug —— 而 `POST /v1/chat/completions`、`/v1/messages` 正常，只有 `/v1/models` 崩，是因为崩点在**鉴权后的模型列表**路径上，而他的「自定义 provider node + `modelAliases`」恰好是第一个走到那条路径的配置。

### 现状核验（实测 registry）

| tag | digest |
|---|---|
| `latest` | `sha256:48f5d76d9bda9acb7a3d98…` |
| `1.1.0` | `sha256:48f5d76d9bda9acb7a3d98…`（与 latest 同一次构建） |
| `1.0.8` | `sha256:293af7f913424fb4a6b525…`（旧的不一致产物） |

```bash
docker pull ghcr.io/techysy/10router:latest   # 或 :1.1.0
```

### 教训

`v1.1.0` 起全部产物构建自**同一个 tagged commit**（已核验：Windows / fpk / server / Docker 四个 workflow 的 `headSha` 全为 `2205ba19`）。「同一版本号、不同产物」这类问题在结构上被排除 —— 前提是 **tag 只推一次、不移动**。

---

## 2. Issue #9 —— 安全审计 11 项逐项现状

审计对象是 v1.0.7，以下为对照 `v1.1.0` 代码逐项复核的结果。**统计：✅ 1 / 🟡 4 / ❌ 6。**

### ✅ 已修（1）

| # | 项 | 证据 |
|---|---|---|
| 9 | Host 头无校验（DNS rebinding） | `src/dashboardGuard.js:93` `LOOPBACK_HOSTS = new Set(["localhost","127.0.0.1","::1"])` + `:98 isLoopbackHostname()`，与 loopback Origin 校验配合 |

### 🟡 部分修复（4）

| # | 项 | 现状 | 证据 |
|---|---|---|---|
| 1 | 默认监听 `0.0.0.0` | 默认值**未改**，但已加真实暴露面提示（算出局域网 IP 并单独告警） | `cli/cli.js:100` `DEFAULT_HOST = "0.0.0.0"`；`getLanIp()` 在 `:103`；`desktop/main.js:335` 仍硬编码 `HOSTNAME: '0.0.0.0'` |
| 5 | `usageHistory` 明文记录全量 key | **出参已脱敏**，但落库列仍写原值（DB 文件本身仍可读到全量 key） | `src/lib/db/repos/usageRepo.js:6 maskApiKey()`（保留前 8 位）、`:340 apiKeyMasked: maskApiKey(r.apiKey)` |
| 7 | MITM 两点 | 问题 B（常量兜底密钥）**未修**；问题 A（Windows 私钥权限）是**已知且写在注释里**的缺口 | `src/mitm/manager.js:98 ENCRYPT_SALT`、`:156-160` `machineIdSync()` 抛错时落到 `sha256(ENCRYPT_SALT)`；`src/mitm/cert/rootCA.js:31` 显式 `if (process.platform === "win32") return;`（注释写明 Windows 由 ACL 管 → 即无 DPAPI/显式 ACL 加固） |
| 10 | `API_KEY_SECRET` 常量兜底 | 已基本修：默认改为随机生成密钥，常量仅作**旧 key CRC 验签兼容**，另有可选轮换开关（默认关，注释说明轮换会让存量 key 的 CRC 全部失效） | `src/shared/utils/apiKey.js:7 LEGACY_FALLBACK_SECRET`、`:57` 返回处；轮换开关 `settings.apiKeyRotation` |

### ❌ 未修（6）

| # | 项 | 证据 | 建议动作 | 工作量 |
|---|---|---|---|---|
| 3 | 未设密时默认密码 `123456` | `src/lib/auth/dashboardSession.js:9 DEFAULT_PASSWORD = "123456"`、`:106 process.env.INITIAL_PASSWORD \|\| DEFAULT_PASSWORD`；`src/app/api/settings/route.js:61-62` 仍把字面量 `"123456"` 当合法 `currentPassword`（即「复活路径」确实存在） | 首次启动强制设密，或随机生成并展示一次；至少去掉字面量 | 小 |
| 2 | 凭据明文落库 | `src/lib/db/repos/connectionsRepo.js:41 data: stringifyJson(rest)`；全仓无凭据加解密（`createCipheriv` 仅见于与本项无关的 `open-sse/shared/qoder/cosy.js`） | 恢复 `enc:v1` 静态加密，或走系统级（DPAPI / Keychain / libsecret）。**需先定密钥来源**，并考虑与 `DATA_DIR` 搬迁/备份的关系 | 中 |
| 4 | `requireLogin=false` 时管理 API 裸奔 | `src/dashboardGuard.js:188 if (settings.requireLogin === false) return true;`，无二次确认、无横幅、无回环限制 | 关闭时二次确认 + dashboard 常驻横幅；或仅允许回环请求关闭 | 小 |
| 6 | 更新器无完整性校验 + CORS 全开 | `src/lib/updater/updater.js:2` 仍 `npm i -g <pkg>@latest`（无 pin / 无哈希）；`:73 Access-Control-Allow-Origin: *` | release 附 sha256 并校验；状态口去掉 CORS 或加 token | 中 |
| 8 | JWT 24h / 登录限流为内存态 | `src/lib/auth/dashboardSession.js:15 SESSION_MAX_AGE_SEC = 24 * 60 * 60` | 缩短至 1–2h + refresh；限流状态持久化（重启即清零） | 中 |
| 11 | 公开路由信息泄露 | `src/dashboardGuard.js:25 /api/init`、`:32 /api/version` 仍在 `PUBLIC_API_PATHS` | 版本信息移入鉴权后 | 小 |

### 关于第 1 项（单独说明立场的理由）

**默认 `0.0.0.0` 是刻意的产品决策，不是疏漏**：10Router 的主场景就是「把本机变成局域网内的网关」，CLI 启动后会直接打印局域网可达地址；默认 `127.0.0.1` 会让主场景失效，用户反而要手动改。因此这里加的是**显式提示**（绑全网卡时打印真实局域网 IP），而不是改默认。

但第 1 项与第 3 项**会互相放大**（全网卡 + 默认口令 = 局域网一步拿管理员）。所以应该先斩断**叠加**（做第 3 项），而不是单独动监听默认值。若最终决定改默认值，两个候选方案：

- **A**：默认 `127.0.0.1`，`--host 0.0.0.0` 显式开启；
- **B**：保留 `0.0.0.0`，但「首次启动强制设密 + 未设密时拒绝非回环访问」。（能保住主场景）

### 建议实施顺序

1. **#3 → #4 → #11**：一串小改动，收益大、工作量小，能立刻消除「叠加打穿」；
2. **#2**：单独作为一个功能做（涉及存量数据迁移，须先定密钥来源与 `DATA_DIR` 搬迁/备份策略）；
3. **#6 / #8**：各自中等工作量，可排在其后。

---

## 3. Issue #10 —— 内容过滤导致 0 输出时的 combo 重试

### 现象与诊断（报告人的诊断已验证正确）

Z.ai（glm 系）在命中内容安全过滤时返回 **HTTP 200**，正常建流，然后以 `finish_reason: "sensitive"` 结束且**零输出 token**。客户端拿到空响应，重试又撞同一个过滤器。

代码侧的确认：

- `open-sse/services/combo.js:308` 的成功判定就是 `if (result.ok)` —— **纯 HTTP 层**，`200` 会在读取 SSE body 之前就被提交为「模型成功」；
- `open-sse/config/errorConfig.js` 的 `ERROR_RULES` 只看 status + 错误文本；
- 全仓对 `finish_reason: "sensitive"` **零处理**，也没有任何空输出检测。

→ 所以「往 combo 里加 fallback 模型」对这个失败模式完全无效。

### 为什么比「在流层检测」要难

**成功判定与对客户端的承诺位于流的两端**：`finish_reason` 只在终止块出现，而那时 combo 层已经返回 `200` 且 body 正在被 pipe 给客户端 —— 在流尾检测已经来不及透明重放。

可行形态是 **延迟承诺（deferred commit）**：

1. 不在首字节就把上游响应提交给客户端，等到流产出**有价值的内容**再放；
2. 出现第一个**非空内容** delta（或 tool call）即放行 —— 本例中上游什么都没发（连 role delta 都没有），所以「等到首个非空 delta」这个条件足够；
3. 若流以**非标准 `finish_reason`** 结束且期间**什么都没放行过**，则丢弃并换下一个 combo 模型。客户端全程没收到任何东西，重放对它不可见。

happy path 上只多了一个「等首个内容 chunk」的缓冲，而这本来也是 SSE 客户端开始渲染的时刻。

### 两个设计要点

1. **要通用检测，不要写死 `"sensitive"`**：判定条件为「终止 `finish_reason` 不在已知白名单（`stop` / `length` / `tool_calls` / `function_call` / `null`）内 **且** 零放行输出」。硬编码列表会漏掉上游下次新造的标记 —— 这与 CodeBuddy 侧 `11102`（上游不认这个 id）vs `11134`（上游认得、暂时不服务）必须分开处理是同一个道理。
2. **务必 opt-in，且要更严**：重放会把输入**重新计费**（本例是 1.5M token 上下文，不是零头），而且换一家也可能撞过滤器。因此：按 combo 的 opt-in 开关、**默认关**，再加一个「单请求最多可烧掉几个模型」的上限；并且当剩余模型与主模型**同厂**时给出警告（报告人自己举的 `tokenrouter/z-ai/glm-5.3-free` 就会撞同一个过滤器）。

### 待补信息

需要那两条 `06:33:26 DONE · OUT 0` 请求的**原始 SSE 尾部**（最后 2–3 个 chunk 的原文），确认上游在终止块之前**真的什么都没发**。若它先发了一个空 content delta，放行条件就要从「首个 delta」收紧为「首个**非空** delta」。`OUT 0` 强烈暗示是前者，但需要原始字节定论。

---

## 4. Issue #13 —— 小米桌面版专属模型的报错要改成「友好提醒」

> 记为下个版本的待办。以下为逐环验证过的根因链。

### 现象

调用桌面版**专属**模型（`mimo-x-pro-preview` / `mimo-x-flash-preview`）而本机没有 MiMo Desktop 账号会话时，客户端拿到：

```
HTTP 502: [xiaomi-mimo/mimo-x-flash-preview] [502]: Xiaomi MiMo account session unavailable. Sign in to MiMo Desktop once so its passToken is present, then retry. (reset after 30s)
```

### 根因链

| 环节 | 位置 | 事实 |
|---|---|---|
| 抛出原始异常 | `open-sse/executors/xiaomi-mimo.js:75-80` | 取不到桌面版 cookie 时 `throw new Error("Xiaomi MiMo account session unavailable. …its passToken is present…")` —— 写给自己看的调试文案直接成了用户可见的 API 错误 |
| 匹配不到任何规则 | `open-sse/services/accountFallback.js:48-49` | `// Default: transient cooldown for any unmatched error` |
| 落到默认瞬时冷却 | `open-sse/config/errorConfig.js:39` | `TRANSIENT_COOLDOWN_MS = 30 * 1000` ← 这才是 `(reset after 30s)` 的来源 |
| 事前零提示 | `open-sse/providers/registry/xiaomi-mimo.js:57-58` | 两个 Preview 行是「裸」的，没有任何字段说明「只认桌面版 Cookie，API key 到不了」 |

### 为什么必须修（不只是文案问题）

「没登录」被当成「被限流」处理，后果不止难看：

1. **不会自愈** —— 30 秒后重试必然以同样方式失败，但 `(reset after 30s)` 在诱导调用方重试；
2. **连累同 provider 其他账号/模型** —— 账号被打了 `rateLimitedUntil`，影响正常调度；
3. **用户唯一的发现途径就是撞一次 502** —— 启用前完全看不到前提条件。

正确语义是 **fail fast**：这是「需要用户完成一次动作」的终态错误，不该进冷却、不该被当作可重试的 502。

### 建议修法（三件事）

- **A. 错误分类**：给这类「需完成一次绑定」的失败一个可判别的类型（如 `MIMO_DESKTOP_SESSION_REQUIRED`），并让 fallback 层显式排除它（不打冷却、不污染同 provider 其他账号）。
- **B. 文案 + 本地化**：改为「该模型需要小米 MiMo 桌面版账号。请先在「添加账号」里完成一次 MiMo 授权码登录，再重试。」按仓库惯例给该消息加 zh-CN / zh-TW locale 条目，并加守卫用例锁住。
- **C. 事前提示**：注册表给这两个模型加 `requiresSession`（或通用 `hint`）字段，dashboard 模型行显示「需小米 MiMo 桌面版登录」徽章 + tooltip 指引。（模型字段无白名单：`open-sse/providers/schema.js` 只强制 `id` + `category`，加字段安全。）

原文：https://github.com/techysy/10router/issues/13

---

## 5. 关联：`gpt-6-astra` 倍率修正（`1b962154`，当时未推送）

| | |
|---|---|
| 改动 | `open-sse/providers/registry/codebuddy-intl.js` 的 `rateMultiplier` **`17.35` → `6.67`** |
| 为什么之前是 17.35 | v1.1.0 出厂值是**估算**：当时仓库、`~/.codebuddy`、官网定价页都取不到 CodeBuddy 的积分数字，于是拿 OpenCode Go 价目表用**比值法**推 —— 该表里 Astra 在四列（输入/输出/缓存读/缓存写）与两个档位上都恰好是 Sol 的 **5 倍**，而 Sol 的公布值是 3.47，故 `3.47 × 5 = 17.35` |
| 结论 | 实际积分体系**不遵循**这个比值，实测为 **6.67**。该估算与其**推算方法一并作废**（注册表注释里写明：不要再拿外部价目表反推这家的倍率，并附 `pricing.js` 里 `gpt-5.4` / `gpt-5.5` 同价但倍率差 2× 的反例） |
| 测试 | 原来锁的是**推算关系**（`astra == sol × 5`），现改为钉住实测值 **并加反向断言** `not.toBeCloseTo(sol × 5)` —— 否则旧注释里那套比值法随时会被人照着再推一遍 |
| 更新日志 | v1.1.0 那条补注「⚠️ 该值后经实测修正为 `6.67`」，标题改为「含一个**后经修正的**估算倍率」；顶部新增 `## Unreleased` 完整记录 |
| 验证 | CodeBuddy 相关用例 24/24；全量 750 套件 / 2438 用例 / **2306 通过 / 38 失败**（基线 40，与改动前完全一致）→ `No regression`；三个注册表基线字节级一致；能力审计无违例 |

> **注意**：该修正**尚未进入任何发布物**（v1.1.0 的产物里仍是 17.35）。要么并入下一个版本，要么单独发一个补丁版。

---

## 6. 待办清单

- [ ] 推送 `1b962154`（未推送，1 个提交；推送只触发 CI，不发版）
- [ ] #9-3 去掉默认口令兜底 + 首次强制设密（小，收益最大）
- [ ] #9-4 `requireLogin=false` 的二次确认与横幅
- [ ] #9-11 `/api/version`、`/api/init` 移入鉴权
- [ ] #9-2 凭据加密落库（需先定密钥来源与迁移策略）
- [ ] #9-6 更新器完整性校验 + CORS 收紧
- [ ] #9-8 会话时长与限流持久化
- [ ] #10 内容过滤重试（等原始 SSE 尾部定论）
- [ ] #13 小米桌面版专属模型：错误分类（不进冷却）+ 中文可执行提示 + 事前徽章（见 §4）
- [ ] 决定 `gpt-6-astra` 修正的发布方式（并入下版 / 补丁版）

---

## 附：审计中值得保持的部分

报告人点名的「做得好的部分」，后续改动继续守住：

- `custom-server.js`：剥离客户端 `X-Forwarded-For`、从 TCP socket 取真实 IP、进程级 peer token、仅信任本机反代的转发头；
- 登录限流按**真实 IP** 键控（防伪造）；
- SQLite 四级适配器降级链（`bun:sqlite` → `better-sqlite3` → `node:sqlite` → `sql.js`）异常处理干净；
- 443 端口回收带 cmdline 守卫，防误杀无关进程。
