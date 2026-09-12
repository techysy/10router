# CodeBuddy 错误码对照与修复速查（CN 与国际版通用）

> 用途：10Router CodeBuddy 两渠道排查时先查这张表定位错误码性质——是**可修的代码问题**、**间歇风控**、还是**上游参数/格式缺陷**，避免一看到 400 就乱改配置。适用渠道：`codebuddy-cn`（alias `cbcn`，上游 `https://copilot.tencent.com`）与 `codebuddy-intl`（alias `cbai`，上游 `https://www.codebuddy.ai`）——**错误码空间两边共用**（`11102`/`11133`/`11134`/`11140` 均已在 intl 观测到），差异处文中单独标注。
> 维护：2026-09-05 汇总历次修复；2026-09-12 补入 11140（intl 账号级风控）并确认全文对 intl 适用。每个码的完整修复细节见「相关文档」列的独立 fix doc。

## 一、错误码速查表

| Code | HTTP | 报错(节选) | 性质 | 归属 | 修复/出路 |
|------|------|-----------|------|------|----------|
| `11101` | 400 | Non-stream chat request is currently not supported | **可修(代码)** | executor | 强制 `stream=true`(CodeBuddy 只支持流式)；10router 为非流式客户端本地聚合 |
| `11128` | 400 | Illegal API invocation from an unapproved channel | **间歇风控** | 服务端 | 无配置可解；等锁恢复/降请求形态/换号。见下方专节 |
| `11133` | 400 | the request parameters were rejected by the model provider (`model_param_invalid`) | **多为客户端/上游缺陷** | mirasim/上游 | 二分请求侧 vs 响应侧定位；workaround 换 hy4。见相关文档 |
| `11134` | 500 | the model provider is temporarily unavailable, please retry later or switch… | **上游临时不可用** | 上游 | 等上游自报的 reset 时间；**不是目录错误，勿因此下架模型**。见下方专节 |
| `11140` | 403 | （账号级风控，拦截整个渠道的对话接口） | **账号级风控（新）** | 服务端 | 本地无解——额度接口仍 200、与请求形态/模型/代理无关；等恢复或换号。见下方专节 |
| `11150` | 400 | reasoning effort value is not supported by the current model | **可修(代码)** | executor | DeepSeek 系不支持 `auto/off` → 请求侧 `auto→high`、`off→删字段`(commit `167f272f`) |
| `11151` | 400 | assistant 带 reasoning | **上游格式** | 上游 | 上游对 assistant 消息携带 reasoning 的校验；规避请求形态 |
| `6004` | 429 | 您的使用量已超出频率限制，将于…重置 | **配额限流** | 服务端 | 等 CodeBuddy 返回的 reset 时间自动恢复；正常配额消耗 |
| `401` | 401 | 鉴权服务请求失败 | **token/网络** | 上游 | 多为一过性网络/鉴权超时，重试；持续则查 token 有效性 |
| `402` | 402 | (billing) | **余额/额度** | 上游 | 账号余额或免费额度耗尽，充值/换号 |

> 记忆口诀：**`11150`/`11101` = 代码可修；`11133` = 客户端序列化/上游格式（10router 多只能兜底）；`11134` = 上游暂时不服务（**认得 id，勿下架**）；`11128` = 服务端间歇风控（非 bug，单请求形态相关）；`11140` = 账号级风控（整渠道拦，等恢复/换号）；`6004`/`429` = 配额限流（等重置）。**

## 二、各错误码详解与修复

### 11101 — 非流式请求不支持（可修）

CodeBuddy 上游只接受流式（HTTP 400 code 11101）。10Router 的 `CodeBuddyExecutor.transformRequest` 强制 `stream=true`，非流式客户端由 10router 本地把 SSE 聚合回 JSON。

- 位置：`open-sse/executors/codebuddy-cn.js`
- 性质：稳定可复现，代码已处理。

### 11128 — unapproved channel 安全策略拦截（间歇风控，勿乱改）

CodeBuddy 服务端**安全策略**对"来自未批准渠道形态"的请求做拦截（官方 displayMsg：请求被安全策略拦截）。排查要点：

- **渠道本身没坏**：同一账号、同一模型在原生 `openai→openai` 小请求下可全绿跑几百次。
- **触发常与单条请求形态相关**，曾命中：
  - `FMT: claude→openai`（Claude 客户端经 10router 翻译进 CodeBuddy）；成功批多为 `openai→openai`
  - **工具定义数多（如 54 个 vs 成功批 31）**——工具数越多越容易被安全启发式判为 agent 滥用
  - 超大上下文（500+ MSG）
  - 账号配额紧张（伴随 429 `6004` / modelLock）时更易触发
- **与账号/格式/模型是否被禁无关**（glm/hy/deepseek 在 54 工具下都曾命中；同两账号切 31 工具 deepseek 立即 200）。
- **无 10router 配置可解**（不是缺 header/key）；出路 = 等 30s 锁自动恢复 / 降请求形态(收敛工具数、消息数) / 换号重试。
- 记忆：`11128 = 间歇风控，自动恢复`。
- 社区：workbuddy/codebuddy 反代项目（codebuddyapi-proxy、workbuddy2api）同样遇到，非本项目特有。

### 11133 — 请求参数被拒（model_param_invalid）

CodeBuddy 对"请求参数不符合模型要求"的笼统表达（`extError.code` 多为 `400001`/`model_param_invalid`）。历次排查真正根因分两类：

1. **响应侧空 name（10router 可修）**：codebuddy 把一次工具调用拆成两条流式 tool_calls，后续 chunk 重复带 `function.name:""`。标准客户端用空 name 覆盖累积名 → `unknown tool ""` → 重发空名请求 → 11133。修复：`open-sse/utils/stream.js` PASSTHROUGH 分支删空 `name`(commit `48e39b44`)。
2. **请求侧序列化丢 name（10router 无法修复）**：客户端(如 **mirasim** 内 dsh)自己把 assistant tool_calls 的 name 序列化丢空，10router 的 `ensureToolCallIds` 只补 `id` 不改 name → 空名已到 codebuddy。workaround：换 **hy4-preview**（mirasim 对其序列化正常），或 10router 返回友好错误。
3. **多轮才触发**：单轮(15-17 MSG)正常，**多轮(54 MSG)** 后历史里出现 tool_calls/tool 响应不匹配才暴露。诊断手法：切**官方 DeepSeek** 复现拿清晰报错("assistant message with 'tool_calls' must be followed by tool messages…")定位真正根因。

### 11134 — 模型提供方暂时不可用（上游临时状态，勿当目录问题）

原文：`the model provider is temporarily unavailable, please retry later or switch [to another model]`，HTTP **500**。

**2026-09-11 在 CodeBuddy 国际版观测到**：`gpt-6-astra` 连续 3 次均返回该码，而同一 id 早前探测过 **200** —— 即同一模型在"可用 / 暂不可用"之间摆动，是上游侧的临时状态，与 10router 的目录、鉴权、请求形态均无关。

**判据（避免误删模型）**：目录级错误是 `11102`（`model service info not found`，**400**）—— 那是"上游不认这个 id"。`11134` 说明**上游认这个 id，只是暂时不服务它**。因此：

- **不要**因为一时调不通就把模型从注册表删掉（同 `11102` 与 `11134` 的区别就是判据）；
- 10router 侧按上游给的 reset 秒数做冷却/重试，或 fallback 到其它模型；
- 与 `gemini-3.5-flash` 的 `429 / code 14003` 同类：**账号或上游的临时状态不算目录错误**（见 `open-sse/providers/registry/codebuddy-intl.js` 头部注释第 (2)/(3) 条旁的相关说明）。

### 11140 — 账号级风控拦截整个渠道（intl 首报 2026-09-12）

HTTP **403**、code `11140`，**账号粒度**拦截该渠道的整个对话接口——与 `11128`（单请求形态相关、可自愈）不同，`11140` 命中后**所有模型、所有请求形态持续 403**。

**首报案例（群友，intl/cbai）**：09-12 00:51 最后一次成功，07:59 首个 11140，08:42 仍 403。已系统排除本地原因：

| 假设 | 排除依据 |
|---|---|
| 账号/token 坏了 | ✗ 额度接口仍回 200 |
| 请求形状被拒 | ✗ 二分 12 种请求形态全 403 |
| 代理/出口被封 | ✗ 20171 与 socks5 出口均同 |
| 单个模型被禁 | ✗ 非单模型，全模型 403 |
| 代码 bug | ✗ 本地 v1.1.0 intl 通道复现一致 |

**结论与出路**：上游新增的账号级风控，本地无任何可改项——**等恢复或换号**。不要因此动目录（模型 id 本身没被判）。

**疑似触发因素（未实锤，仅记录）**：该账号在同一实例里用 **Google 和 GitHub 两个 OAuth 各连了一条连接**——同邮箱注册的两个 OAuth 实为**同一个 CodeBuddy 账号**（两条连接的 JWT `sub` 与 `refreshToken` 完全相同）。轮询/failover 在两条连接间交替打同一账号，疑似放大了风控信号。**单样本无法定因果**，但引出一个通用坑：

> ⚠️ **同邮箱双 OAuth = 同一账号，不构成冗余**。intl 支持经 Google / GitHub OAuth 登录，同一邮箱从两个入口授权会生成两条"看起来独立"的连接，但账号、额度池、风控状态完全同一份——多账号 failover 在这里会**静默失效**。判断方法：对比两条连接的 JWT `sub`（或 refreshToken）是否相同；相同即同账号，删一条并补真正的第二账号。

**与 `11128` 的判别**：`11128` 换个小请求形态立刻恢复（单请求启发式）；`11140` 换什么形态都 403（账号已被标记）。先做一次形态二分再定性。


### 11150 — DeepSeek 系不支持 reasoning_effort auto/off（可修，已提交）

CodeBuddy **DeepSeek 系列模型**(`deepseek-v4-*`)只支持 `low/medium/high/xhigh/max/none`，**不支持 `auto`/`off`**；GLM/Kimi 支持 `auto`。dsh 默认发 `THINK:auto` → 转发即 400 `11150`。

修复(commit `167f272f`，`open-sse/executors/codebuddy-cn.js`)：
- deepseek 系 + `auto` → 映射 `high`
- deepseek 系 + `off` → 删除字段(等同 none)
- 其它值/非 deepseek 逻辑不变

### 11151 — assistant 带 reasoning

CodeBuddy 对 assistant 消息里带 reasoning 内容的校验报错。性质为上游格式约束，规避请求形态。

### 6004 / 429 — 配额频率限制

账号某模型使用量超限返回 `6004`(HTTP 429)，带重置时间，到期自动恢复。属正常配额消耗，10router 多账号会自动 fallback 到下个账号。

## 三、排查方法论（跨错误码可复用）

1. **先分错误码**：看 10router.log 具体 code——`11150`/`11101` 可修，`11133` 多客户端/上游，`11128` 间歇风控，`6004` 等重置。别一看到 400/11128 就改连接。
2. **同模型失败 vs 成功抽差异**：`FMT / MSG / TOOL / THINK / ACC` 五个字段对比，差异项即可疑触发点。
3. **渠道是否死**：此刻渠道能否服务其它模型(如 deepseek-v4-flash 连续 200) → 账号/渠道没死，是单模型/单请求被拦。
4. **请求侧 vs 响应侧二分**：`DEBUG_RAW_REQ`(chat.js 入口) vs `DEBUG_CB_REQ`(transformRequest 后) 对比，一次定位。用后必须清理(移除 env + 临时代码，重新 `npm run build`)。
5. **含糊错误切 provider B 复现**：A 报 11133(param 空)时，切官方 DeepSeek 拿清晰报错定位真正根因。
6. **注明发起客户端**：不同客户端(NAS 直连 dsh / mirasim 内 dsh / codex / Claude Code)路径不同、根因可能不同，先问清/注明。
7. **核对连接是不是真多账号**（intl 尤其重要）：Google/GitHub OAuth 同邮箱 = 同一 CodeBuddy 账号（JWT `sub`/`refreshToken` 相同）——"两条连接"不构成冗余，failover/轮询都在打同一个账号与风控状态。见 `11140` 专节。

## 四、相关文档

| 主题 | 文档 |
|------|------|
| 11150 reasoning_effort | `CodeBuddy-reasoning-effort-fix.md` (en/zh-CN) |
| 11128 间歇风控 + 判别法 | skill: `llm-api-channel-health/references/10router-codebuddy-11128-unapproved-channel.md` |
| 11133 流式空 name(响应侧) | skill: `10router-dev/references/codebuddy-streaming-toolcall-empty-name.md` |
| 11133 模型特定(hy4 vs deepseek) | skill: `10router-dev/references/codebuddy-toolcall-model-specific.md` |
| 11133 请求侧 vs 响应侧 | skill: `10router-dev/references/codebuddy-toolcall-request-vs-response.md` |
| 11133 多轮 + 官方DS诊断 | skill: `10router-dev/references/codebuddy-toolcall-official-ds-multiturn.md` |
| 11128 实测 + onboardUser 归属 | skill: `10router-dev/references/codebuddy-intermittent-11128.md` |
