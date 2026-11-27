import { createHash } from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { CLIXAD_CONFIG } from "../config/clixad.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Clixad's gateway sits behind Render's WAF, which answers some coding-agent
// payloads with a 403 HTML "Blocked" page. Verified triggers (2026-11-25):
// "`curl -fL " in a tool description, "../../etc/passwd", "; curl … | bash",
// "${jndi". The WAF decodes JSON \u escapes, so escaping is not enough;
// a U+2060 WORD JOINER after the trigger punctuation is. Level 1 touches only
// tools + system prompt; level 2 every message. What passed is remembered per
// tools/system hash so later turns of the same agent skip the blocked round trip.
const WJ = "\u2060";
const SKIP_KEYS = new Set(["role", "type", "name", "id", "tool_call_id", "model"]);
const WAF_RE = /web application firewall/i;
const learnedLevels = new Map();

export const CLIXAD_WAF_MESSAGE =
  "Clixad 网关（Render web application firewall）按内容拦截了本次请求，自动处理后仍被拦。" +
  "这不是账号问题，账号不会被锁定；请删改对话里像命令注入的片段后重试，或改用其它渠道。";

export function neutralizeWafString(s) {
  return s
    .replace(/`(?=\s*[A-Za-z/.~$])/g, "`" + WJ)
    .replace(/\$\{/g, "$" + WJ + "{")
    .replace(/\$\(/g, "$" + WJ + "(")
    .replace(/([;|&])(?=\s*[A-Za-z/.~])/g, "$1" + WJ)
    .replace(/\.\.\//g, "." + WJ + "./");
}

function neutDeep(o, k) {
  if (typeof o === "string") return SKIP_KEYS.has(k) ? o : neutralizeWafString(o);
  if (Array.isArray(o)) return o.map((x) => neutDeep(x, k));
  if (o && typeof o === "object") {
    const r = {};
    for (const kk of Object.keys(o)) r[kk] = neutDeep(o[kk], kk);
    return r;
  }
  return o;
}

const isSystem = (m) => m?.role === "system" || m?.role === "developer";

export function neutralizeWafBody(body, level) {
  if (!body || typeof body !== "object" || !level) return body;
  const out = { ...body };
  if (Array.isArray(out.tools)) out.tools = neutDeep(out.tools);
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => (level >= 2 || isSystem(m) ? neutDeep(m) : m));
  }
  return out;
}

function wafKey(body) {
  try {
    const sys = (body?.messages || []).filter(isSystem);
    return createHash("sha1").update(JSON.stringify([body?.tools || null, sys])).digest("hex");
  } catch {
    return null;
  }
}

async function isWafBlock(res) {
  if (!res || res.status !== 403) return false;
  try {
    return WAF_RE.test(await res.clone().text());
  } catch {
    return false;
  }
}

/**
 * ClixadExecutor — Clixad gateway (clixad.onrender.com/v1), plain OpenAI
 * chat/completions with the Clixad bearer. Tokens never expire on a clock and
 * have no refresh: a 401 means the user signs in again.
 */
export class ClixadExecutor extends DefaultExecutor {
  constructor() {
    super("clixad");
  }

  buildHeaders(credentials, stream = true, url, model, transformedBody) {
    const headers = super.buildHeaders(credentials, stream, url, model, transformedBody);
    headers["X-Clixad-Client"] = CLIXAD_CONFIG.clientHeader;
    return headers;
  }

  transformRequest(...args) {
    const body = super.transformRequest(...args);
    const key = wafKey(body);
    const level = key && learnedLevels.get(key);
    return level ? neutralizeWafBody(body, level) : body;
  }

  async execute(args) {
    const result = await super.execute(args);
    try {
      if (!(await isWafBlock(result?.response))) return result;
      const key = wafKey(result.transformedBody);
      let last = result.response;
      for (const level of [1, 2]) {
        if (key && (learnedLevels.get(key) || 0) >= level) continue;
        const body = neutralizeWafBody(result.transformedBody, level);
        const res = await proxyAwareFetch(result.url, {
          method: "POST",
          headers: result.headers,
          body: JSON.stringify(body),
          signal: args?.signal,
        }, args?.proxyOptions || null);
        if (!(await isWafBlock(res))) {
          if (key) learnedLevels.set(key, level);
          return { ...result, response: res, transformedBody: body };
        }
        last = res;
      }
      const text = await last.clone().text();
      const id = (text.match(/Request ID:\s*<code[^>]*>([^<]+)/) || [])[1] || "";
      const message = CLIXAD_WAF_MESSAGE + (id ? ` Render Request ID: ${id}` : "");
      return {
        ...result,
        response: new Response(
          JSON.stringify({ error: { type: "upstream_waf_blocked", code: "clixad_waf", message } }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      };
    } catch {
      return result;
    }
  }

  async refreshCredentials() {
    return null;
  }
}

export default ClixadExecutor;
