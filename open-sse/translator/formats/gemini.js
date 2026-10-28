// Gemini helper functions for translator

import { safeParseJSON } from "../concerns/json.js";
import { OPENAI_BLOCK } from "../schema/index.js";
import { isGemini4Model } from "../../providers/capabilities.js";

// Unsupported JSON Schema constraints that should be removed for Antigravity
export const UNSUPPORTED_SCHEMA_CONSTRAINTS = [
  // Basic constraints (not supported by Gemini API)
  "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "format", "multipleOf",
  // Array keywords the Gemini schema proto has no field for. Agent tool
  // schemas set these routinely, and one occurrence rejects the whole request
  // with "Unknown name ...: Cannot find field".
  "uniqueItems", "contains",
  // 2020-12 keywords with no Gemini equivalent
  "unevaluatedProperties", "unevaluatedItems", "contentSchema",
  // Tuple-array keywords; converted to items first, leftovers stripped
  "prefixItems", "additionalItems",
  // Claude rejects these in VALIDATED mode
  "default", "examples",
  // JSON Schema meta keywords
  "$schema", "$defs", "definitions", "const", "$ref", "$comment",
  // 2019-09/2020-12 identifier and anchor keywords
  "$id", "$anchor", "$dynamicRef", "$dynamicAnchor", "$vocabulary",
  // Array count keywords that ride along with `contains`
  "minContains", "maxContains",
  // Annotation keywords (rejected by Gemini/Antigravity - e.g. MCP tool schemas set these)
  "deprecated", "readOnly", "writeOnly",
  // OpenAI strict tool mode puts `strict` inside `parameters` (RubyLLM and other
  // OpenAI-convention clients); Codex multi-agent tools mark fields `encrypted`.
  // Gemini answers both with 400 "Unknown name ...: Cannot find field".
  "strict", "encrypted",
  // VS Code / JSON Language Service extensions injected by Copilot-style tools
  "markdownDescription", "markdownEnumDescriptions", "enumItemLabels",
  // Object validation keywords (not supported)
  "additionalProperties", "propertyNames", "patternProperties", "enumDescriptions",
  // Complex schema keywords (handled by flattenAnyOfOneOf/mergeAllOf)
  "anyOf", "oneOf", "allOf", "not",
  // Dependency keywords (not supported)
  "dependencies", "dependentSchemas", "dependentRequired",
  // Other unsupported keywords ("deprecated" already listed under annotation keywords)
  "title", "optional", "if", "then", "else", "contentMediaType", "contentEncoding",
  // UI/Styling properties (from Cursor tools - NOT JSON Schema standard)
  "cornerRadius", "fillColor", "fontFamily", "fontSize", "fontWeight",
  "gap", "padding", "strokeColor", "strokeThickness", "textColor",
  // 部分 MCP 工具 schema 携带的非标准注解/报错关键字。Gemini 的 schema proto
  // 没有对应字段,任一嵌套节点出现即以 "Unknown name X: Cannot find field"
  // 整体 400,必须整树剥离(markdownDescription 已在上方 VS Code 扩展段收录)。
  "errorMessage", "errorMessages", "x-errorMessage", "x-errorMessages",
  "x-intellij-html-description", "x-taplo-info", "x-taplo",
  "doNotSuggest", "suggestSortText", "minProperties", "maxProperties"
];

// Default safety settings
export const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
];

// Convert OpenAI content to Gemini parts
export function convertOpenAIContentToParts(content) {
  const parts = [];

  if (typeof content === "string") {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === OPENAI_BLOCK.TEXT) {
        parts.push({ text: item.text });
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url?.startsWith("data:")) {
        const url = item.image_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex); // skip "data:"
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];

          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.IMAGE_URL && item.image_url?.url && (item.image_url.url.startsWith("http://") || item.image_url.url.startsWith("https://"))) {
        parts.push({
          fileData: { fileUri: item.image_url.url, mimeType: "image/*" }
        });
      } else if (item.type === OPENAI_BLOCK.INPUT_AUDIO && item.input_audio?.data) {
        const format = item.input_audio.format || "wav";
        const mimeType = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
        parts.push({
          inlineData: { mime_type: mimeType, data: item.input_audio.data }
        });
      } else if (item.type === OPENAI_BLOCK.AUDIO_URL && item.audio_url?.url?.startsWith("data:")) {
        const url = item.audio_url.url;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimePart = url.substring(5, commaIndex);
          const data = url.substring(commaIndex + 1);
          const mimeType = mimePart.split(";")[0];
          parts.push({
            inlineData: { mime_type: mimeType, data: data }
          });
        }
      } else if (item.type === OPENAI_BLOCK.FILE && item.file?.file_data?.startsWith("data:")) {
        const url = item.file.file_data;
        const commaIndex = url.indexOf(",");
        if (commaIndex !== -1) {
          const mimeType = url.substring(5, commaIndex).split(";")[0];
          const data = url.substring(commaIndex + 1);
          parts.push({ inlineData: { mime_type: mimeType, data: data } });
        }
      }
    }
  }

  return parts;
}

// Extract text content from OpenAI content
export function extractTextContent(content, separator = "") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === OPENAI_BLOCK.TEXT).map(c => c.text).join(separator);
  }
  return "";
}

// Try parse JSON safely (null fallback on parse error; re-export keeps legacy API)
export function tryParseJSON(str) {
  return safeParseJSON(str, null);
}

// Generate request ID
export function generateRequestId() {
  return `agent-${crypto.randomUUID()}`;
}

// Generate session ID (binary-compatible format: UUID + timestamp)
export function generateSessionId() {
  return crypto.randomUUID() + Date.now().toString();
}

// Generate project ID
export function generateProjectId() {
  const adjectives = ["useful", "bright", "swift", "calm", "bold"];
  const nouns = ["fuze", "wave", "spark", "flow", "core"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

// Keys whose value is a name → subschema map. Their own keys are property names,
// not schema keywords — a property literally called "title" or "format" must
// survive keyword stripping, so the walkers descend into the values only.
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
// Keys holding instance data or name lists, never subschemas.
const SCHEMA_DATA_KEYS = new Set(["enum", "const", "default", "examples", "required"]);

// Local $ref inlining budget: stops pathological schemas (deep diamond refs)
// from exploding in size. Refs beyond the budget are stripped like before.
const MAX_REF_INLINES = 256;

const isSchemaNode = v => !!v && typeof v === "object" && !Array.isArray(v);

// Visit every direct subschema of a schema node (or every item of a schema array).
function forEachSubschema(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) visit(item);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== "object" || SCHEMA_DATA_KEYS.has(key)) continue;
    if (SCHEMA_MAP_KEYS.has(key) && !Array.isArray(value)) {
      for (const sub of Object.values(value)) visit(sub);
    } else {
      visit(value);
    }
  }
}

// Build a recursive pass: `apply` runs on each schema node, then the walk descends.
function schemaPass(apply) {
  const pass = node => {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node)) apply(node);
    forEachSubschema(node, pass);
  };
  return pass;
}

function resolveLocalPointer(root, ref) {
  let current = root;
  for (const raw of ref.slice(2).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !(segment in current)) return null;
    current = current[segment];
  }
  return current;
}

// Inline local "#/..." refs (pydantic / FastMCP tool schemas put every model in
// $defs). Stripping $ref without inlining left `{}`, which then became the
// {reason} placeholder and the model lost the real argument shape.
// Siblings of $ref (description, default…) override the resolved target.
function inlineLocalRefs(root) {
  let budget = MAX_REF_INLINES;
  const active = new Set();

  const inline = node => {
    if (Array.isArray(node)) return node.map(inline);
    if (!isSchemaNode(node)) return node;

    const ref = typeof node.$ref === "string" ? node.$ref : "";
    if (ref.startsWith("#/")) {
      const { $ref: _ref, ...rest } = node;
      const target = active.has(ref) || budget <= 0 ? null : resolveLocalPointer(root, ref);
      if (!isSchemaNode(target)) return inline(rest);
      budget--;
      active.add(ref);
      const merged = { ...inline(target), ...inline(rest) };
      active.delete(ref);
      return merged;
    }

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = SCHEMA_DATA_KEYS.has(key) ? value : inline(value);
    }
    return out;
  };

  return inline(root);
}

// Remove unsupported keywords at every schema level. Also strips vendor
// extensions: `x-` fields and `~`-prefixed Standard Schema metadata
// (Zod 4 / Valibot / ArkType leak keys like `~optional`), which Gemini rejects
// the same way as any unknown keyword.
function removeUnsupportedKeywords(schema, keywords) {
  schemaPass(node => {
    for (const key of Object.keys(node)) {
      if (keywords.includes(key) || key.startsWith("x-") || key.startsWith("~")) delete node[key];
    }
  })(schema);
}

// Convert const to enum
const convertConstToEnum = schemaPass(node => {
  if (node.const !== undefined && !node.enum) {
    node.enum = [node.const];
    delete node.const;
  }
});

// Gemini only accepts enum on STRING schemas. Numeric enums can't be expressed,
// so drop them and keep the numeric type; everything else becomes a string enum
// (Gemini returns 400 when an enum has no explicit type:"string").
const convertEnumValuesToStrings = schemaPass(node => {
  if (!Array.isArray(node.enum)) return;
  const type = Array.isArray(node.type) ? node.type.find(t => t !== "null") : node.type;
  if (type === "integer" || type === "number") {
    delete node.enum;
    return;
  }
  node.enum = node.enum.map(v => String(v));
  if (!node.type) node.type = "string";
});

// Merge allOf schemas
const mergeAllOf = schemaPass(node => {
  if (!Array.isArray(node.allOf)) return;
  const merged = {};

  for (const item of node.allOf) {
    if (item?.properties) {
      if (!merged.properties) merged.properties = {};
      Object.assign(merged.properties, item.properties);
    }
    if (Array.isArray(item?.required)) {
      if (!merged.required) merged.required = [];
      for (const req of item.required) {
        if (!merged.required.includes(req)) merged.required.push(req);
      }
    }
  }

  delete node.allOf;
  if (merged.properties) node.properties = { ...node.properties, ...merged.properties };
  if (merged.required) node.required = [...(node.required || []), ...merged.required];
});

// Select best schema from anyOf/oneOf
function selectBest(items) {
  let bestIdx = 0;
  let bestScore = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let score = 0;
    const type = item.type;

    if (type === "object" || item.properties) {
      score = 3;
    } else if (type === "array" || item.items) {
      score = 2;
    } else if (type && type !== "null") {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// Flatten anyOf/oneOf to the richest non-null branch. Loops because the chosen
// branch may itself be a union. The field's own description wins over the
// branch's (the branch is usually a shared $defs model).
const MAX_UNION_DEPTH = 8;
const flattenAnyOfOneOf = schemaPass(node => {
  for (let depth = 0; depth < MAX_UNION_DEPTH; depth++) {
    const key = ["anyOf", "oneOf"].find(k => Array.isArray(node[k]) && node[k].some(s => s && s.type !== "null"));
    if (!key) return;
    const nonNullSchemas = node[key].filter(s => s && s.type !== "null");
    const selected = nonNullSchemas[selectBest(nonNullSchemas)];
    const ownDescription = node.description;
    delete node[key];
    Object.assign(node, selected);
    if (ownDescription !== undefined) node.description = ownDescription;
  }
});

// Flatten type arrays
const flattenTypeArrays = schemaPass(node => {
  if (Array.isArray(node.type)) {
    const nonNullTypes = node.type.filter(t => t !== "null");
    if (nonNullTypes.length === 0) {
      node.type = "string";
    } else if (nonNullTypes.length === 1) {
      node.type = nonNullTypes[0];
    } else {
      // Multiple types: choose best fitting type (prefer structural clues then string over boolean/number)
      if (node.properties && nonNullTypes.includes("object")) {
        node.type = "object";
      } else if (node.items && typeof node.items === "object" && Object.keys(node.items).length > 0 && node.items.type && nonNullTypes.includes("array")) {
        node.type = "array";
      } else if (nonNullTypes.includes("string")) {
        node.type = "string";
      } else if (nonNullTypes.includes("number")) {
        node.type = "number";
      } else if (nonNullTypes.includes("integer")) {
        node.type = "integer";
      } else if (nonNullTypes.includes("boolean")) {
        node.type = "boolean";
      } else {
        node.type = nonNullTypes[0];
      }
    }
  }
});

// Infer missing type=object when properties exist (Gemini requires explicit type)
const ensureObjectType = schemaPass(node => {
  if (node.properties && !node.type) node.type = "object";
});

// Convert prefixItems (tuple validation) to items — Gemini cannot express tuples,
// and a type:"array" schema without items is rejected with "missing field"
const convertPrefixItems = schemaPass(node => {
  if (!Array.isArray(node.prefixItems) || node.prefixItems.length === 0) return;
  const variants = node.prefixItems.filter(s => s && s.type !== "null");
  if (!node.items && variants.length === 1) {
    node.items = variants[0];
  } else if (!node.items && variants.length > 1) {
    node.items = { anyOf: variants };
  }
  delete node.prefixItems;
});

// Gemini requires items on every type:"array" schema — fill a permissive placeholder
const ensureArrayItems = schemaPass(node => {
  if (node.type === "array") {
    if (!node.items || typeof node.items !== "object" || Object.keys(node.items).length === 0) {
      node.items = { type: "string" };
    } else if (!node.items.type) {
      if (node.items.properties) {
        node.items.type = "object";
      } else if (node.items.items) {
        node.items.type = "array";
      } else {
        node.items.type = "string";
      }
    }
  }
});

// Drop required entries that name no declared property
const cleanupRequired = schemaPass(node => {
  if (!Array.isArray(node.required) || !node.properties) return;
  const validRequired = node.required.filter(field =>
    typeof field === "string" && Object.prototype.hasOwnProperty.call(node.properties, field)
  );
  if (validRequired.length === 0) delete node.required;
  else node.required = validRequired;
});

// Antigravity rejects object schemas without properties — add a placeholder field.
// An empty schema {} (left behind by an unresolvable $ref) is treated the same way.
const placeholderReason = () => ({
  type: "object",
  properties: { reason: { type: "string", description: "Brief explanation of why you are calling this tool" } },
  required: ["reason"],
});
const addPlaceholders = schemaPass(node => {
  if (Object.keys(node).length === 0 || (node.type === "object" && (!node.properties || Object.keys(node.properties).length === 0))) {
    Object.assign(node, placeholderReason());
  }
});

// Gemini Schema proto validation rules:
// 1. Schema.items predicate: $type == Type.ARRAY. If type is not "array", items field MUST NOT exist.
// 2. Schema.properties / required predicate: $type == Type.OBJECT. If type is not "object", properties and required MUST NOT exist.
const enforceTypeConstraints = schemaPass(node => {
  if (node.type === "array") {
    delete node.properties;
    delete node.required;
    if (!node.items || typeof node.items !== "object" || Object.keys(node.items).length === 0) {
      node.items = { type: "string" };
    } else if (!node.items.type) {
      if (node.items.properties) {
        node.items.type = "object";
      } else if (node.items.items) {
        node.items.type = "array";
      } else {
        node.items.type = "string";
      }
    }
  } else {
    // Non-array schemas MUST NOT carry items
    delete node.items;
  }

  if (node.type !== "object") {
    delete node.properties;
    delete node.required;
  }
});

// Clean JSON Schema for Antigravity API compatibility - removes unsupported keywords recursively.
// Returns a new schema; the input is not modified.
export function cleanJSONSchemaForAntigravity(schema) {
  if (!schema || typeof schema !== "object") return schema;

  // Phase 0: Resolve local $ref against $defs/definitions before they are stripped
  const cleaned = inlineLocalRefs(schema);

  // Phase 1: Convert and prepare
  convertConstToEnum(cleaned);
  convertEnumValuesToStrings(cleaned);

  // Phase 2: Flatten complex structures
  mergeAllOf(cleaned);
  convertPrefixItems(cleaned);
  flattenAnyOfOneOf(cleaned);
  flattenTypeArrays(cleaned);

  // Phase 2.5: Infer missing type=object when properties exist (Gemini requirement)
  ensureObjectType(cleaned);
  ensureArrayItems(cleaned);

  // Phase 3: Remove all unsupported keywords at ALL levels (including inside arrays)
  removeUnsupportedKeywords(cleaned, UNSUPPORTED_SCHEMA_CONSTRAINTS);

  // Phase 4: Cleanup required fields recursively
  cleanupRequired(cleaned);

  // Phase 5: Add placeholder for empty object schemas (Antigravity requirement)
  addPlaceholders(cleaned);

  // Phase 6: Enforce Gemini protobuf type predicates (items only on array, properties/required only on object)
  enforceTypeConstraints(cleaned);

  return cleaned;
}

// Gemini requires functionDeclaration.parameters to be an OBJECT schema. Some
// clients send a root without `type` ({properties} only), a scalar/array root,
// or nothing at all — coerce the root, then run the full cleaner.
// A root without `type` keeps its keywords (unions/allOf may still resolve to an
// object); a scalar or array root has nothing to keep but its description.
export function toGeminiParameters(parameters) {
  const root = isSchemaNode(parameters) ? parameters : {};
  let objectRoot = root;
  if (root.type === undefined) {
    objectRoot = { ...root, type: "object" };
  } else if (root.type !== "object") {
    objectRoot = { type: "object", properties: {} };
    if (typeof root.description === "string") objectRoot.description = root.description;
  }
  return cleanJSONSchemaForAntigravity(objectRoot);
}


// Placeholders for turns Gemini requires but the client didn't send
const GEMINI_LEADING_USER_TEXT = "...";
const GEMINI_CONTINUE_TEXT = "Continue.";

// Gemini 4 rejects a merged user turn whose last part is not a functionResponse (#4802)
function moveFunctionResponsesLast(parts) {
  const responses = parts.filter(p => p.functionResponse);
  if (!responses.length) return parts;
  return [...parts.filter(p => !p.functionResponse), ...responses];
}

// Normalize Gemini contents: drop empty parts/turns and merge adjacent same-role turns.
// `guardTurns` (Antigravity) also makes the conversation start with a user turn and
// never end on a model turn — a trailing model turn gets a "Continue." user turn, and
// trailing unanswered functionCalls get matching functionResponses, since Gemini
// rejects a functionCall that is not followed by its response.
export function normalizeGeminiContents(contents, { guardTurns = false, model = null } = {}) {
  const frLast = isGemini4Model(model);
  const out = [];
  for (const c of contents || []) {
    if (!c?.role || !Array.isArray(c.parts)) continue;
    const parts = c.parts.filter(p => p && typeof p === "object" && Object.keys(p).length > 0);
    if (parts.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === c.role) {
      last.parts.push(...parts);
      if (frLast) last.parts = moveFunctionResponsesLast(last.parts);
    } else out.push({ ...c, parts });
  }
  if (!guardTurns || out.length === 0) return out;

  if (out[0].role !== "user") {
    out.unshift({ role: "user", parts: [{ text: GEMINI_LEADING_USER_TEXT }] });
  }
  const tail = out.at(-1);
  if (tail.role === "model") {
    const calls = tail.parts.filter(p => p.functionCall);
    out.push({
      role: "user",
      parts: calls.length > 0
        ? calls.map(({ functionCall }) => ({
            functionResponse: {
              ...(functionCall.id && { id: functionCall.id }),
              name: functionCall.name || "tool",
              response: { result: GEMINI_CONTINUE_TEXT },
            },
          }))
        : [{ text: GEMINI_CONTINUE_TEXT }],
    });
  }
  return out;
}
