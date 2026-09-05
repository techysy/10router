# CodeBuddy CN (codebuddy-cn) 上游错误码对照与修复速查

> 用途：10Router `codebuddy-cn` 渠道（alias `cbcn`，上游 `https://copilot.tencent.com`）排查时先查这张表定位错误码性质——是**可修的代码问题**、**间歇风控**、还是**上游参数/格式缺陷**，避免一看到 400 就乱改配置。
> 维护：2026-09-05 汇总历次修复。每个码的完整修复细节见「相关文档」列的独立 fix doc。

## 一、错误码速查表

| Code | HTTP | 报错(节选) | 性质 | 归属 | 修复/出路 |
|------|------|-----------|------|------|----------|
| `11101` | 400 | Non-stream chat request is currently not supported | **可修(代码)** | executor | 强制 `stream=true`(CodeBuddy 只支持流式)；10router 为非流式客户端本地聚合 |
| `11128` | 400 | Illegal API invocation from an unapproved channel | **间歇风控** | 服务端 | 无配置可解；等锁恢复/降请求形态/换号。见下方专节 |
| `11133` | 400 | the request parameters were rejected by the model provider (`model_param_invalid`) | **多为客户端/上游缺陷** | mirasim/上游 | 二分请求侧 vs 响应侧定位；workaround 换 hy4。见相关文档 |
| `11150` | 400 | reasoning effort value is not supported by the current model | **可修(代码)** | executor | DeepSeek 系不支持 `auto/off` → 请求侧 `auto→high`、`off→删字段`(commit `167f272f`) |
| `11151` | 400 | assistant 带 reasoning | **上游格式** | 上游 | 上游对 assistant 消息携带 reasoning 的校验；规避请求形态 |
| `6004` | 429 | 您的使用量已超出频率限制，将于…重置 | **配额限流** | 服务端 | 等 CodeBuddy 返回的 reset 时间自动恢复；正常配额消耗 |
| `401` | 401 | 鉴权服务请求失败 | **token/网络** | 上游 | 多为一过性网络/鉴权超时，重试；持续则查 token 有效性 |
| `402` | 402 | (billing) | **余额/额度** | 上游 | 账号余额或免费额度耗尽，充值/换号 |

> 记忆口诀：**`11150`/`11101` = 代码可修；`11133` = 客户端序列化/上游格式（10router 多只能兜底）；`11128` = 服务端间歇风控（非 bug）；`6004`/`429` = 配额限流（等重置）。**

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
