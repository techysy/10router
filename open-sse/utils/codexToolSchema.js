// Codex-specific tool JSON Schema compatibility.
//
// `https://chatgpt.com/backend-api/codex/responses` validates every function tool's
// `parameters` with a regex engine that implements no Unicode property escapes. A
// `pattern` such as
//
//   "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./\\[\\]]{1,200}$"
//
// is a valid ECMAScript `u`-mode regex, yet Codex answers
//
//   400 Invalid schema for function 'Artifact': '^\\p{Cc}...' is not a 'regex'
//   param: tools[0].parameters
//
// The body is therefore deterministically malformed for this provider: every account
// fails identically and a combo pays a full failover per turn before landing somewhere
// that accepts the pattern (#3922).
//
// Scope guardrail: this is NOT a global schema sanitizer. It runs only on the Codex
// dispatch path, and only drops `pattern` values that actually carry a property escape.
// A provider that does support `\\p{...}` keeps its constraint untouched, and every other
// node passes through by reference.

// `\\p{...}` / `\\P{...}` behind an odd number of backslashes: an even count means the
// backslash itself is escaped, so `\\\\p{Cc}` is a literal "p" and must be left alone.
const UNICODE_PROPERTY_ESCAPE = /(^|[^\\])(\\\\)*\\[pP]\{/;

export function hasUnicodePropertyEscape(pattern) {
  return typeof pattern === "string" && UNICODE_PROPERTY_ESCAPE.test(pattern);
}

// Copy-on-write walk: returns the original reference when nothing changed, so an untouched
// schema keeps object identity and the caller can cheaply detect a no-op (the same schema
// may then be retried against a provider that accepts the pattern).
//
// `properties` is special-cased because its keys are arbitrary property *names* — one may
// literally be called "pattern" or "properties" — and must never be read as schema
// keywords; every other key recurses as an ordinary schema node.
function stripNode(node, stats) {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const cleaned = stripNode(item, stats);
      if (cleaned !== item) changed = true;
      return cleaned;
    });
    return changed ? next : node;
  }
  if (!node || typeof node !== "object") return node;

  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" && hasUnicodePropertyEscape(value)) {
      stats.removed++;
      changed = true;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      let propsChanged = false;
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        const cleaned = stripNode(propSchema, stats);
        if (cleaned !== propSchema) propsChanged = true;
        props[propName] = cleaned;
      }
      if (propsChanged) changed = true;
      next[key] = propsChanged ? props : value;
      continue;
    }
    const cleaned = stripNode(value, stats);
    if (cleaned !== value) changed = true;
    next[key] = cleaned;
  }
  return changed ? next : node;
}

// Drops only the `pattern` constraints Codex's validator rejects. Returns the same
// reference when the schema is already compatible. `stats.removed` counts the drops so
// the caller can log them.
export function stripCodexUnsupportedPatterns(schema, stats = { removed: 0 }) {
  return stripNode(schema, stats);
}
