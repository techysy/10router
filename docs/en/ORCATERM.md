# OrcaTerm OAuth provider

This branch adds a native OrcaTerm provider, not a second OpenAI proxy process.
Clients continue to use 10Router's normal `/v1` API.

## Sign in

1. Build and run this branch following the repository's build instructions.
2. Open `/dashboard/providers/orcaterm` and add an OAuth connection.
3. Click **Open the WeChat QR page**. It opens OrcaTerm's own authorize page
   (`/oauth/authorize?provider=wechat&source=desktop`) in a new tab. Scan it with
   WeChat. If the browser then offers to open the OrcaTerm app, cancel it.
4. Back in the dashboard, click **I have scanned it, finish sign-in**.
5. Use the connection test to validate the account, then make a real model request.

This is the sign-in the official OrcaTerm desktop client uses. 10Router creates
an OrcaTerm session id and a PKCE (S256) challenge; the verifier never leaves the
10Router server. After the scan, 10Router redeems the session once with
`OAuthExchangeToken` and receives an access token **and a distinct refresh
token**. Sign-in links expire after five minutes and can be redeemed only once,
so a failed or early "finish" needs a new link.

The embedded WeChat widget (`/oauth/wechat/exchange`) is no longer used: it
returns an access token only, and OrcaTerm now refuses to renew an access token
by itself (`OAuthRefreshToken` with `accessToken` answers `SESSION_EXPIRED`, and an
access token sent as `refreshToken` answers `INVALID_REFRESH_TOKEN`). Connections
created that way stop working when their two-hour token expires and must sign in
again with the flow above.

The exchange and token renewal happen on the 10Router server. No token is
returned to the dashboard, and no Tencent Cloud console cookie, local browser
profile, browser automation or loopback callback port is required. Existing
10Router dashboard authentication and credential encryption remain in use.
Authorize requests are limited to 20 per client IP per 10 minutes, with at most
32 active login sessions.

Renewal sends the refresh token to `OAuthRefreshToken`. OrcaTerm rotates it on
every renewal, and 10Router stores the new pair. Renewal requests are
deduplicated. A revoked grant requires another sign-in; this is not permanent
login or a way to bypass account limits.

## Models and API

Model IDs keep OrcaTerm's namespace. For example:

```json
{
  "model": "orcaterm/TokenHub/deepseek-v4.1-flash",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true
}
```

The initial catalog contains these eight selector-visible IDs:

- `TokenHub/deepseek-v4.1-flash`
- `TokenHub/deepseek-v4-flash`
- `TokenHub/deepseek-v4-pro`
- `TokenHub/kimi-k3`
- `TokenHub/glm-5.3-flash`
- `TokenHub/glm-5.3`
- `TokenHub/glm-5.2`
- `Hunyuan3/hy3`

Unknown IDs are rejected instead of passed through to hidden upstream models.
Availability and quotas depend on the account and OrcaTerm's current catalog.

The executor translates the native ACP request and SSE response into OpenAI
Chat Completions, including non-streaming responses and `reasoning_content`.
The normal 10Router translators handle other supported client formats.
Requested output is capped at 8,096 tokens. Usage is not invented when the
upstream omits it.

## Tool and image compatibility

- Tool definitions are sent through `emphasisPrompt`. Only declared client
  tools are converted to OpenAI `tool_calls`; 10Router does not execute them.
- Calls are sequential. A matching tool result resumes the native conversation
  through `reviewAction: "reportToolResult"`.
- Continuation state is scoped to the account/connection and model, bounded to
  256 entries and ten minutes. A restart, account switch, expired entry or retry
  rebuilds a fresh request from the supplied transcript instead of reporting
  the same non-idempotent tool result twice.
- Undeclared/native upstream tool requests fail instead of becoming executable
  client calls. Automatic upstream tool execution is disabled.
- Image conversion is limited to base64 PNG/JPEG/WebP/GIF data URLs on
  DeepSeek V4.1 Flash and Kimi K3. Remote URLs are not fetched. Limits are four
  images, 10 MB per image and 20 MB total.

## Verification boundaries

Offline tests cover the OAuth state/one-use/expiry boundaries, credential
redaction, token renewal, ACP conversion, tool continuation, image validation,
SSE framing, Unicode, cancellation and upstream error propagation.

The authorize page can be checked without signing in. The desktop sign-in and
refresh-token rotation were verified against a real account (two consecutive
background renewals, each using the refresh token stored by the previous one);
model calls, tool round trips and image requests still depend on that account. Passing mocked
tests or the billing-based connection test does not establish that every
listed model is enabled for that account.

The implementation was independently written using the public protocol
references in [orcaterm-model-proxy](https://github.com/lyp0709/orcaterm-model-proxy)
and [opencode-orcaterm-auth](https://github.com/hg1048596-pixel/opencode-orcaterm-auth).
