# CodeBuddy CN (codebuddy-cn) Upstream Error Codes — Reference & Fixes

> Purpose: When troubleshooting the 10Router `codebuddy-cn` channel (alias `cbcn`, upstream `https://copilot.tencent.com`), consult this table first to classify the error — **code bug (fixable)** vs **intermittent risk-control** vs **upstream/client format defect** — so you don't chase config changes on a 400.
> Maintained: 2026-09-05, consolidating past fixes. Full per-code details live in the docs listed in "Related docs".

## 1. Error-code quick table

| Code | HTTP | Message (excerpt) | Nature | Owner | Fix / path |
|------|------|-------------------|--------|-------|-----------|
| `11101` | 400 | Non-stream chat request is currently not supported | code bug (fixable) | executor | force `stream=true` (CodeBuddy is stream-only); 10router aggregates SSE→JSON for non-stream clients |
| `11128` | 400 | Illegal API invocation from an unapproved channel | **intermittent risk-control** | server | not config-fixable; wait for lock / reduce request shape / rotate account. See section below |
| `11133` | 400 | the request parameters were rejected by the model provider (`model_param_invalid`) | mostly client/upstream defect | mirasim/upstream | bisect request-side vs response-side; workaround = use hy4. See related docs |
| `11150` | 400 | reasoning effort value is not supported by the current model | code bug (fixable) | executor | DeepSeek rejects `auto`/`off` → request-side `auto→high`, `off→drop` (commit `167f272f`) |
| `11151` | 400 | assistant carries reasoning | upstream format | upstream | upstream validation on assistant-carried reasoning; avoid that request shape |
| `6004` | 429 | 使用量已超出频率限制，将于…重置 | quota rate-limit | server | auto-recovers per CodeBuddy reset time; normal quota consumption |
| `401` | 401 | 鉴权服务请求失败 | token/network | upstream | usually one-off timeout; retry; persistent → check token |
| `402` | 402 | (billing) | balance/quota | upstream | account balance/free quota exhausted; top up / rotate |

> Mnemonic: **`11150`/`11101` = code fixable; `11133` = client serialization/upstream format (10router mostly can only mitigate); `11128` = intermittent server risk-control (not a bug); `6004`/`429` = quota limit (wait for reset).**

## 2. Per-code details & fixes

### 11101 — Non-stream not supported (fixable)
CodeBuddy upstream only accepts streaming (HTTP 400 code 11101). `CodeBuddyExecutor.transformRequest` forces `stream=true`; 10router aggregates SSE→JSON for non-streaming clients.
- Location: `open-sse/executors/codebuddy-cn.js`

### 11128 — unapproved-channel security-policy block (intermittent, don't over-edit)
CodeBuddy server **security policy** blocks requests it deems "from an unapproved channel". Key points:
- **Channel is not broken**: same account+model in native `openai→openai` small requests can run green hundreds of times.
- Trigger correlates with single-request shape; observed:
  - `FMT: claude→openai` (Claude client translated into CodeBuddy); successful batches were mostly `openai→openai`
  - **high tool-count (e.g. 54 vs ~31 on successful batches)** — the more tools, the more likely the security heuristic flags agent-abuse
  - huge context (500+ MSG)
  - account under quota pressure (accompanied by 429 `6004` / modelLock)
- **Not about account/format/model being banned** (glm/hy/deepseek all hit it at 54 tools; the same two accounts go straight 200 on a 31-tool deepseek).
- **Not 10router-config fixable** (no missing header/key); path = wait for the 30s lock to clear / reduce request shape (fewer tools/messages) / rotate account.
- Memory: `11128 = intermittent risk-control, auto-recovers`.
- Community: workbuddy/codebuddy reverse-proxy projects (codebuddyapi-proxy, workbuddy2api) hit it too — not specific to this project.

### 11133 — request parameters rejected (model_param_invalid)
CodeBuddy's vague expression for "parameters don't meet model requirements" (`extError.code` mostly `400001`/`model_param_invalid`). Past investigations found two real root causes:
1. **Response-side empty name (10router fixable)**: codebuddy splits one tool call into two streamed tool_calls; later chunks repeat `function.name:""`. Clients overwrite the accumulated name with the empty one → `unknown tool ""` → resends an empty-name request → 11133. Fix: `open-sse/utils/stream.js` PASSTHROUGH branch deletes the empty `name` (commit `48e39b44`).
2. **Request-side name dropped (10router can't fix)**: the client (e.g. **mirasim**-hosted dsh) serializes assistant tool_calls with an empty name itself; 10router's `ensureToolCallIds` only fills `id`, never fixes `name` → empty name reaches CodeBuddy. Workaround: use **hy4-preview** (mirasim serializes it correctly), or return a friendly error from 10router.
3. **Multi-turn trigger**: single-turn (15-17 MSG) is fine; **multi-turn (54 MSG)** surfaces a historical tool_calls/tool mismatch. Diagnostic: repro on **official DeepSeek** for a clear error ("assistant message with 'tool_calls' must be followed by tool messages…") to pin the real root cause.

### 11150 — DeepSeek rejects reasoning_effort auto/off (fixable, committed)
CodeBuddy **DeepSeek-series models** support only `low/medium/high/xhigh/max/none`, **not `auto`/`off`**; GLM/Kimi support `auto`. dsh sends `THINK:auto` by default → forwarded verbatim → 400 `11150`.

Fix (commit `167f272f`, `open-sse/executors/codebuddy-cn.js`):
- deepseek + `auto` → map to `high`
- deepseek + `off` → drop the field (equivalent to `none`)
- other values / non-deepseek logic unchanged

### 11151 — assistant carries reasoning
CodeBuddy validation when an assistant message carries reasoning content. Upstream format constraint; avoid that request shape.

### 6004 / 429 — quota frequency limit
An account exceeding a model's usage cap returns `6004` (HTTP 429) with a reset time; auto-recovers. Normal quota consumption; 10router multi-account fallback switches to the next account automatically.

## 3. Diagnostic methodology (reusable across codes)
1. **Classify the code first**: read 10router.log — `11150`/`11101` fixable, `11133` mostly client/upstream, `11128` intermittent, `6004` wait for reset. Don't edit connection config on a bare 400/11128.
2. **Diff same-model failure vs success**: compare the `FMT / MSG / TOOL / THINK / ACC` fields; the difference is the suspect trigger.
3. **Is the channel dead?** If the channel serves other models right now (e.g. deepseek-v4-flash stream 200 continuously), the account/channel is alive — a single model/request is being blocked.
4. **Bisect request-side vs response-side**: `DEBUG_RAW_REQ` (chat.js entry) vs `DEBUG_CB_REQ` (end of transformRequest). Clean up afterwards (remove env + temp code, re-run `npm run build`).
5. **Repro an opaque error on provider B**: when A returns 11133 (empty param), repro on official DeepSeek for a clear message that pinpoints the root cause.
6. **Note the calling client**: NAS-direct dsh / mirasim-hosted dsh / codex / Claude Code take different paths with different root causes — ask/note which before diagnosing.

## 4. Related docs
- `11150` reasoning_effort → `docs/en|zh-CN/CodeBuddy-reasoning-effort-fix.md`
- `11128` intermittent + discrimination method → skill `llm-api-channel-health/references/10router-codebuddy-11128-unapproved-channel.md`
- `11133` stream empty-name (response side) → skill `10router-dev/references/codebuddy-streaming-toolcall-empty-name.md`
- `11133` model-specific (hy4 vs deepseek) → skill `10router-dev/references/codebuddy-toolcall-model-specific.md`
- `11133` request-vs-response → skill `10router-dev/references/codebuddy-toolcall-request-vs-response.md`
- `11133` multi-turn + official-DS diagnostics → skill `10router-dev/references/codebuddy-toolcall-official-ds-multiturn.md`
- `11128` live test + onboardUser ownership → skill `10router-dev/references/codebuddy-intermittent-11128.md`
