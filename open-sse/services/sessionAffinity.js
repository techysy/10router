import { createHmac, randomBytes } from "node:crypto";
import { ROLE } from "../translator/schema/roles.js";
import { CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { SESSION_ROUTING as CFG } from "../config/routingStrategies.js";

const sessionFields = ["session_id", "sessionId", "conversation_id", "conversationId", "chat_id", "chatId", "thread_id", "threadId"];
const sessionHeaders = ["x-session-id", "session-id", "session_id", "x-claude-code-session-id", "x-amp-thread-id", "x-conversation-id"];
const secret = randomBytes(32);
const hash = (...parts) => createHmac("sha256", secret).update(JSON.stringify(parts)).digest("base64url");

function id(value) {
  if (typeof value !== "string" || value.length > CFG.maxIdLength) return null;
  return value.trim() || null;
}

function explicitSession(container) {
  for (const key of sessionFields) {
    const value = id(container?.[key]);
    if (value) return value;
  }
  return null;
}

function nestedSession(raw) {
  if (typeof raw === "object") return explicitSession(raw);
  if (typeof raw !== "string" || raw.length > CFG.maxMetadataLength) return null;
  const value = raw.trim();
  if (value.startsWith("{")) {
    try { return explicitSession(JSON.parse(value)); } catch { return null; }
  }
  // CD-style explicitly session-shaped user_id, and Claude Code's legacy suffix.
  return id(value.match(/_session_([a-f0-9-]{8,})$/i)?.[1]) || (/^ses_[\w-]+$/.test(value) ? id(value) : null);
}

function resultIds(body) {
  const items = Array.isArray(body?.input) ? body.input : body?.messages;
  const refs = new Set();
  if (!Array.isArray(items)) return refs;
  const add = (value) => { const key = id(value); if (key) refs.add(key); };
  // Read only the trailing tool-result batch, never historical calls in a new turn.
  for (let n = 1; n <= CFG.maxToolIds && n <= items.length; n++) {
    const item = items[items.length - n];
    if (item?.role === ROLE.TOOL) add(item.tool_call_id);
    else if ([RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT].includes(item?.type)) add(item.call_id);
    else if (item?.role === ROLE.USER && Array.isArray(item.content)) {
      for (const block of item.content.slice(0, CFG.maxToolIds)) {
        if (block?.type === CLAUDE_BLOCK.TOOL_RESULT) add(block.tool_use_id);
      }
      break;
    } else break;
  }
  return refs;
}

export function createRoutingIdentity(body, headers, caller) {
  // Without an authenticated key or a known peer there is no reliable isolation.
  if (!caller) return null;
  const meta = body?.metadata;
  const session = explicitSession(meta) || nestedSession(meta?.user_id ?? meta?.userId)
    || explicitSession(body) || explicitSession(body?.request)
    || sessionHeaders.map((name) => id(headers?.get?.(name))).find(Boolean);
  const refs = resultIds(body);
  if (!session && !refs.size) return null;
  return { caller, session: session ? hash("session", session) : null, refs: [...refs].map((ref) => hash("call", ref)) };
}

export function routingCaller(apiKey, peer) {
  if (apiKey) return hash("key", apiKey);
  return peer && peer !== "unknown" ? hash("peer", peer) : null;
}

function put(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
}

function live(map, key) {
  const value = map.get(key);
  if (value && Date.now() - value.at < CFG.idleMs) return value;
  map.delete(key);
  return null;
}

export function createSessionScheduler() {
  const pools = new Map();
  const bindings = new Map();
  const calls = new Map();

  return {
    plan(scope, identity, members) {
      if (!identity || !members.length) return null;
      const callerScope = hash(scope, identity.caller);
      const matched = new Set(identity.refs.map((ref) => live(calls, hash(callerScope, ref))?.session)
        .filter((session) => session && live(bindings, hash(callerScope, session))));
      // A changed request id can continue only an unambiguous, actually emitted call.
      // Do not override a distinct session that is already known to this pool.
      const direct = identity.session && live(bindings, hash(callerScope, identity.session));
      const session = direct ? identity.session : matched.size === 1 ? [...matched][0] : identity.session;
      if (!session) return null;
      const key = hash(callerScope, session);
      const bound = live(bindings, key);
      let pool = pools.get(scope);
      if (!pool) pool = { cursor: 0 };
      put(pools, scope, pool, CFG.maxPools);
      const index = members.indexOf(bound?.member);
      const start = index >= 0 ? index : pool.cursor % members.length;
      return {
        order: [...members.slice(start), ...members.slice(0, start)],
        advance(first) {
          const firstIndex = members.indexOf(first);
          if (!bound && firstIndex >= 0) pool.cursor = (firstIndex + 1) % members.length;
        },
        commit(member, ids = []) {
          // An in-flight request cannot recreate old state after a config reset.
          if (pools.get(scope) !== pool) return;
          const at = Date.now();
          put(bindings, key, { scope, member, at }, CFG.maxBindings);
          for (const value of ids) {
            const clean = id(value);
            if (!clean) continue;
            const callKey = hash(callerScope, hash("call", clean));
            const prev = live(calls, callKey);
            // Providers occasionally reuse call ids. Mark collisions ambiguous.
            const owner = prev && prev.session !== session ? null : session;
            put(calls, callKey, { scope, session: owner, at }, CFG.maxAliases);
          }
        },
      };
    },
    reset(scope) {
      if (scope == null) { pools.clear(); bindings.clear(); calls.clear(); return; }
      pools.delete(scope);
      for (const map of [bindings, calls]) for (const [key, value] of map) if (value.scope === scope) map.delete(key);
    },
  };
}

export const comboSessions = createSessionScheduler();
export const accountSessions = createSessionScheduler();
