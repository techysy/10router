# 非流式请求（省略 stream 字段）被误判为流式 — 修复与实验性开关

> 修复日期：2026-09-05 · 关联 issue：[#4](https://github.com/techysy/10router/issues/4) · PR：[#6](https://github.com/techysy/10router/pull/6)
> 影响版本：v1.0.3 起（上游 9router 继承逻辑，上游 master 同样未修）；修复随 v1.0.7 发布

## 背景

用户通过 **WorkBuddy**（OpenAI 兼容客户端）调用 10Router 的 `/v1/chat/completions` 时报连接/解析错误，curl 亦可复现。请求体**省略 `stream` 字段**——按 OpenAI 规范，省略即默认非流式，应返回 `application/json`。

实际返回却是 `content-type: text/event-stream`，body 为一段 JSON 再拼一行 `data: [DONE]`。严格的 JSON 解析器（官方 SDK、curl + jq 等）直接报错。

## 根因

`open-sse/handlers/chatCore.js` 的流式判定：

```js
// 修复前（chatCore.js:115）
let stream = providerRequiresStreaming ? true : (body.stream !== false);
```

`stream` 字段省略时 `body.stream` 为 `undefined`，而 `undefined !== false` 恒为 `true` → **默认走流式**，与 OpenAI 规范（省略 = 非流式）相反。

代码里有一个 Accept 头回退（客户端显式 `Accept: application/json` 时强制非流式），但官方 SDK 与 curl 发送的是 `Accept: */*`，回退永远不触发。

该逻辑由上游 9router 继承而来（`fd7a881c` 历史重塑时并入），上游 master 至今同样未修。

## 修复：实验性开关 `strictStreamDefault`

直接翻转默认值会**静默破坏**一类存量客户端：省略 `stream` 但实际按 SSE 解析的宽松实现（历史上不少客户端依赖此行为）。因此修复放在实验性开关后面，**默认关闭 = 保持现状**：

| `strictStreamDefault` | 省略 `stream` 时 | 语义 |
|----------------------|-----------------|------|
| `false`（默认） | 流式（SSE） | 上游兼容行为，存量客户端零感知 |
| `true` | **非流式（JSON）** | OpenAI 规范行为（issue #4 诉求） |

显式 `stream: true` / `stream: false` 在两档下行为完全一致。

### 实现

判定抽为纯函数 `open-sse/utils/streamDefault.js`（符合 open-sse「配置驱动、逻辑可单测」的约定）：

```js
export function resolveStreamDefault({ bodyStream, providerRequiresStreaming, strictStreamDefault }) {
  if (providerRequiresStreaming) return true;
  return strictStreamDefault === true ? bodyStream === true : bodyStream !== false;
}
```

传参链（open-sse 引擎不碰 DB，保持模块边界）：

```
settingsRepo.DEFAULT_SETTINGS.strictStreamDefault (默认 false)
  → GET/PATCH /api/settings（无白名单，新键自动持久化）
  → src/sse/handlers/chat.js 读 chatSettings.strictStreamDefault
  → handleChatCore({ ..., strictStreamDefault })
  → resolveStreamDefault(...)
```

UI：Profile → 实验性功能 新增「OpenAI-spec stream default」开关（zh-CN / zh-TW 词条已补）。

### 两档下均不变的行为

- **`forceStream` 供应商**（openai / codex / codebuddy-cn / codebuddy-intl / commandcode / grok-cli / zed 共 7 个注册了 `forceStream: true`）：无论开关与请求字段，一律流式——这些上游只支持流式。
- **Accept 头回退**：显式 `Accept: application/json` 仍强制非流式。
- **deepseek-tui 非交互分支**、**图像生成模型强制非流式分支**：判定顺序在 `resolveStreamDefault` 之后，行为不变。
- **内部调用方**（模型 ping、供应商测试）本就显式传 `stream: false`，零影响。

## 验证

单测 `tests/unit/stream-default.test.js`（7 用例）锁定两档真值表：

```
legacy 档: 省略→流式 · true→流式 · false→非流式
strict 档: 省略→非流式 · true→流式 · false→非流式
forceStream: 两档 × 全部输入 → 恒流式
```

issue 报告者的等价验证：对编译产物做 4 处 `!1!==x.stream` → `!0===x.stream` 临时补丁（即 strict 档语义），WorkBuddy 流式 + 非流式均恢复正常。

## 相关注意事项

1. **上游残留问题（未修，P2）**：流式请求带 `tools` 参数时，SSE 尾部会发**两个** `data: [DONE]`。SDK 在第一个即停止解析，不致命；与本修复独立，留待后续。
2. **开关是全局的**：`strictStreamDefault` 作用于所有非 `forceStream` 供应商的 `/v1/chat/completions` 流量，无按供应商粒度。
3. **未来若上游修复默认值**：`resolveStreamDefault` 的 legacy 分支可整体移除，开关退役。
