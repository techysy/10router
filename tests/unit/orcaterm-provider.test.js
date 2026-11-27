import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { ORCATERM_CONFIG } from "../../open-sse/config/orcaterm.js";
import { OrcaTermExecutor } from "../../open-sse/executors/orcaterm.js";
import { buildOrcaTermRequest, OrcaTermReply, readOrcaTermEvents } from "../../open-sse/shared/orcaterm/protocol.js";
import { exchangeOrcaTermCode, exchangeOrcaTermSession, refreshOrcaTermToken, startOrcaTermLogin } from "../../open-sse/shared/orcaterm/auth.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { parseModel } from "../../open-sse/services/model.js";
import { OAUTH_PROVIDERS } from "../../src/shared/constants/providers.js";

vi.mock("../../open-sse/utils/proxyFetch.js", async (original) => ({
  ...await original(),
  proxyAwareFetch: vi.fn(),
}));

const MODEL = "TokenHub/deepseek-v4.1-flash";
const jwt = (fields = {}) => `e30.${Buffer.from(JSON.stringify({
  userId: "orca-test-user", exp: Math.floor(Date.now() / 1000) + 7200, ...fields,
})).toString("base64url")}.signature`;
const credentials = () => ({ accessToken: jwt(), connectionId: "orca-connection" });
const body = () => ({ messages: [{ role: "user", content: "hello" }] });
const json = (value, status = 200) => Response.json(value, { status });
const sse = (...values) => new Response(values.map(
  (value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
).join(""), { headers: { "Content-Type": "text/event-stream" } });

beforeEach(() => vi.mocked(proxyAwareFetch).mockReset());
afterEach(() => vi.restoreAllMocks());

it("registers as a native OAuth provider and preserves the model's namespace when routing", () => {
  expect(OAUTH_PROVIDERS.orcaterm).toBeDefined();
  expect(getExecutor("orcaterm")).toBeInstanceOf(OrcaTermExecutor);
  expect(parseModel(`orcaterm/${MODEL}`)).toMatchObject({ provider: "orcaterm", model: MODEL });
});

describe("OrcaTerm authentication", () => {
  it("uses the product-scoped WeChat flow, not a console session", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ code: 0, data: {
      appid: "wx-test", state: "login-state", scope: "snsapi_login", redirect_uri: ORCATERM_CONFIG.bridgeUrl,
    } }));
    expect(await startOrcaTermLogin()).toMatchObject({ appid: "wx-test", state: "login-state" });
    expect(proxyAwareFetch).toHaveBeenCalledWith(ORCATERM_CONFIG.wechatConfigUrl, expect.any(Object), undefined);
  });

  it("rejects an unexpected bridge instead of sending a code to another origin", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ code: 0, data: {
      appid: "wx-test", state: "s", scope: "snsapi_login", redirect_uri: "https://example.com/bridge",
    } }));
    await expect(startOrcaTermLogin()).rejects.toThrow("unsupported");
  });

  it("exchanges code/state and uses the access token as the renewable credential", async () => {
    const token = jwt();
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ code: 0, data: { accessToken: token } }));
    const result = await exchangeOrcaTermCode("wechat-code", "state");
    expect(result).toMatchObject({ userId: "orca-test-user", accessToken: token, refreshToken: token });
    expect(result.expiresIn).toBeGreaterThan(7000);
    expect(JSON.parse(vi.mocked(proxyAwareFetch).mock.calls[0][1].body)).toEqual({ code: "wechat-code", state: "state" });
  });

  it("deduplicates renewal and rotates both persisted token fields", async () => {
    const oldToken = jwt({ nonce: "renewal-test" });
    const newToken = jwt({ nonce: "rotated" });
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ data: { Response: { AccessToken: newToken } } }));
    const [first, second] = await Promise.all([refreshOrcaTermToken(oldToken), refreshOrcaTermToken(oldToken)]);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ accessToken: newToken, refreshToken: newToken });
    // The upstream Joi schema requires data.refreshToken; sending accessToken instead
    // is rejected with INVALID_REQUEST before the token is even inspected.
    const sent = JSON.parse(vi.mocked(proxyAwareFetch).mock.calls[0][1].body);
    expect(sent).toEqual({ action: "OAuthRefreshToken", data: { refreshToken: oldToken } });
  });

  it("prefers a distinct rotated refresh token when the server issues one", async () => {
    const oldToken = jwt({ nonce: "rotating-source" });
    const newAccess = jwt({ nonce: "rotated-access" });
    const newRefresh = jwt({ nonce: "rotated-refresh" });
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ data: { Response: { accessToken: newAccess, refreshToken: newRefresh } } }));
    expect(await refreshOrcaTermToken(oldToken)).toMatchObject({ accessToken: newAccess, refreshToken: newRefresh });
  });

  it("keeps the rotated refresh token from the desktop grant's PascalCase response", async () => {
    const oldRefresh = jwt({ nonce: "desktop-refresh" });
    const newAccess = jwt({ nonce: "desktop-access" });
    const newRefresh = jwt({ nonce: "desktop-rotated" });
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ data: { Response: {
      Code: 0, AccessToken: newAccess, RefreshToken: newRefresh, ExpiresIn: 7200,
    } } }));
    expect(await refreshOrcaTermToken(oldRefresh)).toMatchObject({ accessToken: newAccess, refreshToken: newRefresh });
  });

  it("redeems a desktop session for an access token, a refresh token and the account identity", async () => {
    const access = jwt({ nonce: "pkce-access" });
    const refresh = jwt({ nonce: "pkce-refresh" });
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ data: { Response: {
      Code: 0, AccessToken: access, RefreshToken: refresh, ExpiresIn: 7200,
      User: { UserId: 42, Username: "Orca user" },
    } } }));
    const result = await exchangeOrcaTermSession("orca-session", "verifier");
    expect(result).toMatchObject({ accessToken: access, refreshToken: refresh, userId: "42", displayName: "Orca user" });
    expect(JSON.parse(vi.mocked(proxyAwareFetch).mock.calls[0][1].body)).toEqual({
      action: "OAuthExchangeToken", data: { sessionId: "orca-session", codeVerifier: "verifier" },
    });
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ data: { Response: { Error: { Code: "TOKEN_EXPIRED" } } } }));
    await expect(exchangeOrcaTermSession("orca-session", "verifier")).rejects.toMatchObject({ status: 400, code: "TOKEN_EXPIRED" });
  });

  it("distinguishes a revoked grant from transient upstream failures", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(json({}, 401));
    expect(await refreshOrcaTermToken(jwt({ nonce: "revoked" }))).toEqual({ error: "invalid_grant" });
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(json({}, 503));
    expect(await refreshOrcaTermToken(jwt({ nonce: "transient" }))).toBeNull();
  });

  it("does not disable a still-valid account when renewal is requested too early", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(json({ code: "TOKEN_NOT_EXPIRED" }));
    expect(await refreshOrcaTermToken(jwt({ nonce: "not-expired" }))).toBeNull();
  });
});

describe("OrcaTerm protocol", () => {
  it("preserves system and tool-result history, clamps output, and disables upstream execution", () => {
    const input = {
      max_tokens: 100000,
      messages: [
        { role: "system", content: "Keep the user's instructions" },
        { role: "assistant", content: null, tool_calls: [{ id: "old-call", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "old-call", content: "actual file content" },
      ],
    };
    const { payload } = buildOrcaTermRequest(MODEL, input, credentials());
    expect(payload.input.emphasisPrompt).toContain("Keep the user's instructions");
    expect(payload.input.input).toContain("actual file content");
    expect(payload.input.input).toContain("old-call");
    expect(payload.user.setting.enableAutoSubtaskExecution).toBe(false);
    expect(payload.user.setting.tools).toEqual([]);
    expect(payload.user.setting.modelDesc.kwargs.max_tokens).toBe(8096);
  });

  it("streams escaped envelope text without leaking the envelope or splitting surrogate pairs", () => {
    const reply = new OrcaTermReply({ tools: [] });
    expect(reply.feed('{"action":"completion","taskCompletion":"hello\\n\\uD83D')).toEqual({ content: "hello\n" });
    expect(reply.feed('\\uDE00"}')).toEqual({ content: "\uD83D\uDE00" });
    expect(reply.finish()).toEqual({ delta: null, finishReason: "stop" });
  });

  it("preserves ordinary JSON answers that are not ACP envelopes", () => {
    const reply = new OrcaTermReply({ tools: [] });
    expect(reply.feed('{"example":true}')).toBeNull();
    expect(reply.finish().delta).toEqual({ content: '{"example":true}' });
  });

  it("maps declared tools and resumes through reportToolResult only for the same account", () => {
    const creds = credentials();
    const definition = { type: "function", function: { name: "read_file", parameters: { type: "object" } } };
    const context = buildOrcaTermRequest(MODEL, { ...body(), tools: [definition] }, creds);
    const tool = { type: "ui", uiServer: ORCATERM_CONFIG.toolNamespace, name: "read_file", args: { path: "test.txt" } };
    const reply = new OrcaTermReply(context);
    reply.feed(JSON.stringify({ action: "review", tool }));
    const end = reply.finish();
    const call = end.delta.tool_calls[0];
    expect(end.finishReason).toBe("tool_calls");
    expect(call.function).toEqual({ name: "read_file", arguments: '{"path":"test.txt"}' });
    const followUp = { messages: [{ role: "tool", tool_call_id: call.id, content: "file result" }] };
    const foreign = buildOrcaTermRequest(MODEL, followUp, { ...creds, connectionId: "another-account" });
    expect(foreign.payload.input.type).toBe("start");
    const resumed = buildOrcaTermRequest(MODEL, followUp, creds);
    expect(resumed.payload.conversationId).toBe(context.payload.conversationId);
    expect(resumed.payload.input).toMatchObject({ type: "review", reviewAction: "reportToolResult", toolResult: "file result", tool });
    expect(buildOrcaTermRequest(MODEL, followUp, creds).payload.input.type).toBe("start");
  });

  it("never converts an undeclared upstream tool into an executable client call", () => {
    const reply = new OrcaTermReply({ tools: [], rememberTool: vi.fn() });
    reply.feed(JSON.stringify({ action: "review", tool: { name: "execute_command" } }));
    expect(() => reply.finish()).toThrow("undeclared tool");
  });

  it("rejects remote image URLs and preserves supported base64 images", () => {
    const input = (url) => ({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] });
    expect(() => buildOrcaTermRequest(MODEL, input("https://127.0.0.1/private"), credentials())).toThrow("base64");
    const request = buildOrcaTermRequest(MODEL, input("data:image/png;base64,YWJj"), credentials());
    expect(request.payload.input.files[0]).toMatchObject({ mimeType: "image/png", bytes: "YWJj" });
    expect(() => buildOrcaTermRequest("TokenHub/glm-5.3", input("data:image/png;base64,YWJj"), credentials())).toThrow("does not support images");
    expect(getCapabilitiesForModel("orcaterm", "TokenHub/glm-5.3")).toMatchObject({ vision: false, maxOutput: 8096 });
  });

  it("propagates HTTP-200 error frames instead of treating them as empty success", async () => {
    await expect(async () => {
      for await (const _event of readOrcaTermEvents(sse({ code: 429, message: "chat-rpm" }))) { /* drain */ }
    }).rejects.toMatchObject({ status: 429 });
  });

  it("handles fragmented UTF-8, CRLF frames and an unterminated final event", async () => {
    const bytes = new TextEncoder().encode('data: {"content":"\u4f60\u597d"}\r\n\r\ndata: {"content":"!"}');
    const response = new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    }));
    const values = [];
    for await (const event of readOrcaTermEvents(response)) values.push(event.content);
    expect(values).toEqual(["\u4f60\u597d", "!"]);
  });
});

describe("OrcaTerm executor", () => {
  it("returns OpenAI JSON with reasoning and no invented usage", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(sse(
      { reasoning: true, reasoningContent: "thinking" },
      { content: '{"action":"completion","taskCompletion":"hello"}' }, "[DONE]",
    ));
    const result = await new OrcaTermExecutor().execute({ model: MODEL, body: body(), credentials: credentials(), stream: false });
    expect(result.response.status).toBe(200);
    const completion = await result.response.json();
    expect(completion.choices[0].message).toMatchObject({ content: "hello", reasoning_content: "thinking" });
    expect(completion).not.toHaveProperty("usage");
    expect(proxyAwareFetch).toHaveBeenCalledWith(ORCATERM_CONFIG.chatUrl, expect.objectContaining({
      headers: expect.objectContaining({ "X-Product": "orcaterm" }),
    }), null);
  });

  it("emits standard streaming chunks and the DONE marker", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(sse({ content: "hello" }, { content: " world" }, "[DONE]"));
    const result = await new OrcaTermExecutor().execute({ model: MODEL, body: body(), credentials: credentials(), stream: true });
    const text = await result.response.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"content":" world"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("preserves auth/rate errors for normal 10Router fallback before streaming starts", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(sse({ code: 429, message: "chat-rpm" }));
    const result = await new OrcaTermExecutor().execute({ model: MODEL, body: body(), credentials: credentials(), stream: true });
    expect(result.response.status).toBe(429);
  });

  it("reports a mid-stream failure rather than emitting a successful stop", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(sse({ content: "partial" }, "[ERROR]: backend disconnected"));
    const result = await new OrcaTermExecutor().execute({ model: MODEL, body: body(), credentials: credentials(), stream: true });
    const text = await result.response.text();
    expect(text).toContain('"content":"partial"');
    expect(text).toContain('"error":');
    expect(text).not.toContain('"finish_reason":"stop"');
  });

  it("cancels the upstream body promptly when the downstream reader disconnects", async () => {
    const cancel = vi.fn();
    vi.mocked(proxyAwareFetch).mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"content":"first"}\n\n')); },
      cancel,
    })));
    const result = await new OrcaTermExecutor().execute({ model: MODEL, body: body(), credentials: credentials(), stream: true });
    const reader = result.response.body.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancel).toHaveBeenCalled();
    expect(vi.mocked(proxyAwareFetch).mock.calls[0][1].signal.aborted).toBe(true);
  });
});
