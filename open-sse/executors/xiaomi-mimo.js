import { DefaultExecutor } from "./default.js";
import { getMimoAccountCookie, invalidateMimoAccountCookieCache, mimoApiBaseFor, MIMO_API_UA } from "../shared/mimoAccount.js";
import { normalizeMimoApiBase } from "../config/providers.js";

// The `mimo-desktop` card's models are served by the account service's /api/route
// proxy, authorized by the Xiaomi account session (NOT the sk- key). See
// shared/mimoAccount.js for the session handshake.
//
// Keyed on the PROVIDER id, not the model id. Both cards sell the same ids
// (mimo-v2.6-pro / -flash), so only the provider separates them; a model-id rule
// would send the Desktop card's call to the billing API while holding a cookie,
// and the cloud card's call through the account service.
const ACCOUNT_SESSION_PROVIDER = "mimo-desktop";

// Session cookie resolved in execute() (async) and read back by buildHeaders()
// (sync — BaseExecutor.execute does not await it). Carried on the per-request
// credentials object, same as runtimeTransport.
const COOKIE_KEY = "__mimoAccountCookie";

const ULTRA_THINKING_DIRECTIVES = {
  high: "Please UltraThinking: conduct a thorough chain-of-thought analysis before taking action or answering. Systematically explore alternative approaches, verify intermediate steps, and address edge cases while strictly adhering to tool invocation schemas if calling tools.",
  xhigh: "Please UltraThinking (Extended): conduct an extensive, multi-step chain-of-thought analysis before taking action or answering. Rigorously challenge all assumptions, stress-test edge cases and failure modes, actively construct counterexamples, and strictly adhere to tool invocation schemas if calling tools.",
};

function injectThinkingDirective(messages, directive) {
  if (!directive || !Array.isArray(messages)) return messages;
  const alreadyInjected = messages.some((m) =>
    typeof m.content === "string" && (m.content.includes("Please UltraThinking") || m.content.includes("[Thinking Directive]")),
  );
  if (alreadyInjected) return messages;

  const copy = messages.map((m) => ({ ...m }));
  const sys = copy.find((m) => m.role === "system");
  if (sys) {
    if (typeof sys.content === "string") {
      sys.content = `${sys.content}\n\n[Thinking Directive]\n${directive}`;
    } else if (Array.isArray(sys.content)) {
      sys.content = [...sys.content, { type: "text", text: `\n\n[Thinking Directive]\n${directive}` }];
    }
  } else {
    copy.unshift({ role: "system", content: directive });
  }
  return copy;
}

export class XiaomiMimoExecutor extends DefaultExecutor {
  // Provider id is a parameter because two registry cards share this executor:
  // `xiaomi-mimo` (cloud models) and `mimo-desktop` (account-session models).
  constructor(provider = "xiaomi-mimo") {
    super(provider);
  }

  /** True for the card whose models spend Desktop credits via the account service. */
  usesAccountSession() {
    return this.provider === ACCOUNT_SESSION_PROVIDER;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // The account-session card's models live on the account-service route, which
    // is not one of the declared transports — resolve it before the default
    // runtimeTransport path.
    if (this.usesAccountSession()) {
      // 账号路由跟随连接的区域集群（providerSpecificData.region，缺省 cn）。
      return `${mimoApiBaseFor(credentials?.providerSpecificData)}/api/route/chat/completions`;
    }
    // The endpoint the platform handed back at sign-in (stored as psd.baseUrl —
    // exactly what MiMo Desktop keeps in auth.json metadata.base_url) decides the
    // cluster: billing keys get api.xiaomimimo.com, Token Plan subscribers get a
    // token-plan-{region} host. The registry transports hardcode the billing host,
    // so rebuild from the stored base whenever one is present. For the default
    // billing base this reproduces the transport URL byte-for-byte.
    const rt = credentials?.runtimeTransport;
    const stored = normalizeMimoApiBase(credentials?.providerSpecificData?.baseUrl);
    if (rt?.baseUrl && stored) {
      if (rt.baseUrl.endsWith("/anthropic/v1/messages")) {
        return `${stored.replace(/\/v1$/, "")}/anthropic/v1/messages`;
      }
      return `${stored}/chat/completions`;
    }
    // Cloud API models keep default handling, so a Claude-format client reaches
    // the /anthropic/v1/messages transport.
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  buildHeaders(credentials, stream = true, url, model) {
    if (this.usesAccountSession() && credentials?.[COOKIE_KEY]) {
      // Account-session models authenticate with the cookie, not the key.
      return {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        "User-Agent": MIMO_API_UA,
        Cookie: credentials[COOKIE_KEY],
      };
    }
    return super.buildHeaders(credentials, stream, url, model);
  }

  transformRequest(model, body, stream, credentials) {
    // super runs stripUnsupportedParams, which flattens content-part arrays for
    // the account-session card (see the rule in translator/concerns/paramSupport.js).
    const out = super.transformRequest(model, body, stream, credentials);

    // Account-session models: bridge thinking effort (from Claude Code /effort or
    // OpenAI reasoning_effort) via system prompt directives and dynamic max_tokens
    // budgets. super.transformRequest can return undefined when no body was
    // provided — skip the bridge rather than crash on a non-object.
    if (this.usesAccountSession() && out && typeof out === "object") {
      const rawEffort = out.reasoning_effort || body?.reasoning_effort || body?.output_config?.effort;
      const effort = typeof rawEffort === "string" ? rawEffort.toLowerCase() : null;

      if (effort === "xhigh" || effort === "max" || effort === "ultra") {
        out.messages = injectThinkingDirective(out.messages, ULTRA_THINKING_DIRECTIVES.xhigh);
        if (!out.max_tokens) out.max_tokens = 65536;
      } else if (effort === "high") {
        out.messages = injectThinkingDirective(out.messages, ULTRA_THINKING_DIRECTIVES.high);
        if (!out.max_tokens) out.max_tokens = 32768;
      } else if (effort === "medium") {
        if (!out.max_tokens) out.max_tokens = 16384;
      } else if (effort === "low") {
        if (!out.max_tokens) out.max_tokens = 8192;
      } else {
        if (!out.max_tokens) out.max_tokens = 4096;
      }

      if (out.thinking == null) out.thinking = { type: "enabled" };
      if (out.temperature == null) out.temperature = 1.0;
      if (out.top_p == null) out.top_p = 0.95;
    }

    return out;
  }

  async execute(args) {
    const { model, credentials, proxyOptions = null } = args;
    if (!this.usesAccountSession()) return super.execute(args);

    const cookie = await getMimoAccountCookie(credentials?.providerSpecificData, proxyOptions);
    if (!cookie) {
      // No MiMo Desktop session = a CONFIGURATION state, not a transient fault:
      // retrying after a cooldown fails identically and the cooldown would taint
      // sibling accounts. The exact wording is load-bearing — errorConfig's
      // fallback rule "mimo desktop account" matches it (cooldown 0 = fail fast,
      // no account lock, no "(reset after 30s)" on the client) and the zh-CN /
      // zh-TW literals are keyed on it. Keep them in sync.
      const err = new Error(
        "This model requires the Xiaomi MiMo desktop account. Sign in to MiMo Desktop once, then retry.",
      );
      err.code = "MIMO_DESKTOP_SESSION_REQUIRED";
      throw err;
    }
    credentials[COOKIE_KEY] = cookie;
    const result = await super.execute(args);

    // A cached session can expire early — drop it and retry once with a fresh one.
    if (result.response.status === 401) {
      invalidateMimoAccountCookieCache();
      const fresh = await getMimoAccountCookie(credentials?.providerSpecificData, proxyOptions).catch(() => null);
      if (fresh) {
        credentials[COOKIE_KEY] = fresh;
        return super.execute(args);
      }
    }
    return result;
  }
}

export const __test__ = { ACCOUNT_SESSION_PROVIDER, COOKIE_KEY };

export default XiaomiMimoExecutor;
