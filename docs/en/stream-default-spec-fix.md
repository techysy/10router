# Non-streaming requests (omitted `stream` field) misjudged as streaming — fix & experimental toggle

> Fixed: 2026-09-05 · Issue: [#4](https://github.com/techysy/10router/issues/4) · PR: [#6](https://github.com/techysy/10router/pull/6)
> Affected versions: v1.0.3 onward (inherited from upstream 9router, whose master is still unfixed); the fix ships with v1.0.7

## Background

A user reported connection/parse errors when calling 10Router's `/v1/chat/completions` through **WorkBuddy** (an OpenAI-compatible client); curl reproduces it too. The request body **omits the `stream` field** — per the OpenAI spec, an omitted `stream` means non-streaming, and the server must return `application/json`.

Instead, 10Router returned `content-type: text/event-stream` with a JSON body followed by a trailing `data: [DONE]` line. Strict JSON parsers (official SDKs, `curl | jq`, …) fail on it.

## Root cause

The streaming decision in `open-sse/handlers/chatCore.js`:

```js
// before the fix (chatCore.js:115)
let stream = providerRequiresStreaming ? true : (body.stream !== false);
```

When `stream` is omitted, `body.stream` is `undefined`, and `undefined !== false` is always `true` → **streaming by default**, the opposite of the OpenAI spec (omitted = non-streaming).

There is an Accept-header fallback (explicit `Accept: application/json` forces non-streaming), but official SDKs and curl send `Accept: */*`, so it never fires.

The logic was inherited from upstream 9router (merged in during the `fd7a881c` history rewrite); upstream master still has the same line.

## The fix: experimental toggle `strictStreamDefault`

Flipping the default unconditionally would **silently break** legacy clients that omit `stream` yet parse the response as SSE (a historically common lenient usage). So the fix ships behind an experimental toggle, **default OFF = current behavior preserved**:

| `strictStreamDefault` | Omitted `stream` | Semantics |
|----------------------|------------------|-----------|
| `false` (default) | streaming (SSE) | upstream-compatible behavior; zero impact on legacy clients |
| `true` | **non-streaming (JSON)** | OpenAI-spec behavior (the issue #4 ask) |

Explicit `stream: true` / `stream: false` behave identically in both modes.

### Implementation

The decision is extracted into a pure function `open-sse/utils/streamDefault.js` (matching the open-sse convention: config-driven, unit-testable logic):

```js
export function resolveStreamDefault({ bodyStream, providerRequiresStreaming, strictStreamDefault }) {
  if (providerRequiresStreaming) return true;
  return strictStreamDefault === true ? bodyStream === true : bodyStream !== false;
}
```

Plumbing (the open-sse engine never touches the DB — module boundary preserved):

```
settingsRepo.DEFAULT_SETTINGS.strictStreamDefault (default false)
  → GET/PATCH /api/settings (no whitelist; new key persists automatically)
  → src/sse/handlers/chat.js reads chatSettings.strictStreamDefault
  → handleChatCore({ ..., strictStreamDefault })
  → resolveStreamDefault(...)
```

UI: Profile → Experimental gains an “OpenAI-spec stream default” toggle (zh-CN / zh-TW literals added).

### Behavior unchanged in both modes

- **`forceStream` providers** (7 registered: openai / codex / codebuddy-cn / codebuddy-intl / commandcode / grok-cli / zed): always stream regardless of the toggle and the request field — those upstreams only support streaming.
- **Accept-header fallback**: explicit `Accept: application/json` still forces non-streaming.
- **deepseek-tui non-interactive branch** and **image-generation forced-non-streaming branch**: evaluated after `resolveStreamDefault`, untouched.
- **Internal callers** (model ping, provider tests) already send `stream: false` explicitly — zero impact.

## Verification

Unit test `tests/unit/stream-default.test.js` (7 cases) locks the truth table for both modes:

```
legacy:  omitted → stream · true → stream · false → non-stream
strict:  omitted → non-stream · true → stream · false → non-stream
forceStream: both modes × all inputs → always stream
```

Equivalent verification from the issue reporter: patching the compiled bundle in 4 places (`!1!==x.stream` → `!0===x.stream`, i.e. strict-mode semantics) made both streaming and non-streaming calls work in WorkBuddy.

## Notes

1. **Known upstream leftover (unfixed, P2)**: streaming requests with a `tools` parameter emit **two** `data: [DONE]` markers at the end. SDKs stop parsing at the first one, so it is not fatal; independent of this fix, left for later.
2. **The toggle is global**: `strictStreamDefault` applies to all non-`forceStream` providers' `/v1/chat/completions` traffic; there is no per-provider granularity.
3. **If upstream ever fixes the default**: the legacy branch of `resolveStreamDefault` can be removed wholesale and the toggle retired.
