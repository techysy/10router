// Combo `router` strategy — decision-model pre-routing (issue #73).
//
// Semantics: a System One decision model reads the request and picks WHICH
// combo member answers (typed decision out, member id back); the chosen member
// then answers through the normal chat pipeline. It deliberately does NOT
// make a decision model a fusion judge — judges synthesize prose answers,
// decision models emit typed distributions (see issue #73 "非目标").
//
// This module is the pure decision core (payload build + response parse +
// membership guard). The orchestrator that calls it lives app-side
// (src/sse/handlers/comboRouter.js) because routing a decision through
// handleSystemone needs the src/sse auth glue.

const TEXT_CAP = 2000;
const ANSWER_CAP = 64;

function clampText(s, cap = TEXT_CAP) {
  const t = String(s ?? "").trim();
  return t.length > cap ? `${t.slice(0, cap)}…` : t;
}

// Last user turn — the decision's core signal. String content or
// [{type:"text",…}] blocks both flatten to text.
function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
    }
    return "";
  }
  return "";
}

function extractToolName(t) {
  if (!t) return "";
  if (typeof t === "string") return t;
  return String(t.name || t.function?.name || "");
}

/**
 * Build the decision payload from the chat body + candidate member list.
 *   state     = last user turn + tool-call intent + a one-line per-member card
 *   questions = one `choice` question: which member should answer
 *
 * Member descriptions come from the resolved model info (name / provider /
 * capabilities) plus optional live health (7d success rate, when the app side
 * has traffic data) so the decision model has real criteria to rank on. The
 * answer vocabulary is the exact candidate ids — anything outside is guarded
 * downstream and degrades to fallback.
 *
 * @returns {{state: string, questions: Record<string, object>}}
 */
export function buildRouterDecisionPayload(body, candidates = [], modelInfoResolver = null) {
  const intent = clampText(lastUserText(body));
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .map(extractToolName)
    .filter(Boolean)
    .slice(0, 12);
  const wantsTools = tools.length > 0 || body?.tool_choice != null;
  const streaming = body?.stream === true;

  const memberLines = candidates.map((m) => {
    const info = modelInfoResolver ? modelInfoResolver(m) : null;
    const caps = [];
    if (info?.vision) caps.push("vision");
    if (info?.tools) caps.push("tools");
    if (info?.pdf) caps.push("pdf");
    if (info?.search) caps.push("search");
    const ctx = info?.contextWindow ? ` ~${Math.round(info.contextWindow / 1000)}k ctx` : "";
    // Live 7d health, when the caller has traffic data — lets the decision
    // model deprioritize "capable but currently flaky" members. Absent for
    // cold members: say so, never fabricate a number.
    const health = info?.health != null
      ? `, health ${info.health}/100 (success ${info.successRate}%)`
      : "";
    const label = clampText(info?.name || m, 80);
    return `- ${m} (${label}${ctx ? `,${ctx}` : ""}${caps.length ? `, ${caps.join("/")}` : ""}${health})`;
  });

  const stateParts = [
    intent ? `User request: ${intent}` : "User request: (no text content in this turn)",
    `Client expects: ${streaming ? "streaming" : "non-streaming"} reply${wantsTools ? "; tool/function calling in play" : ""}`,
    tools.length ? `Tools offered: ${tools.join(", ")}` : "",
    `Candidate models (pick exactly one id):\n${memberLines.join("\n")}`,
  ].filter(Boolean);

  // Drex/System One `choice` questions take `criteria` — an object whose keys
  // are the answer labels and whose values are descriptions (string | null)
  // — and REJECT `options` with "must be an object with options". The keys are
  // what come back in `choice`, so the vocabulary is exactly the member ids.
  // Descriptions stay null: each one costs input tokens, and the per-member
  // capability card already lives in `state`.
  //
  // Keys are object keys, so two ids sharing a 64-char prefix would collapse
  // into one option and silently shrink the vocabulary. Long ids therefore
  // keep their full length (`choice` labels are not length-capped by the API);
  // ANSWER_CAP only applies when it is lossless.
  const criteria = {};
  for (const m of candidates) {
    const id = String(m);
    criteria[id.length > ANSWER_CAP ? id : clampText(id, ANSWER_CAP)] = null;
  }

  return {
    state: stateParts.join("\n"),
    questions: {
      pick_model: {
        type: "choice",
        instructions: "Pick the single best candidate model id to answer this request.",
        criteria,
      },
    },
  };
}

function firstAnswerValue(answer) {
  if (answer == null) return null;
  if (typeof answer === "string") return answer;
  if (typeof answer !== "object") return null;
  // choice shape: {type:"choice", choice:"...", options:[{text/index...}]}
  if (typeof answer.choice === "string") return answer.choice;
  if (Array.isArray(answer.choices) && answer.choices.length > 0) {
    const c = answer.choices[0];
    return typeof c === "string" ? c : (c?.text ?? c?.value ?? null);
  }
  if (typeof answer.value === "string") return answer.value;
  if (typeof answer.text === "string") return answer.text;
  if (typeof answer.answer === "string") return answer.answer;
  if (answer.selected != null) {
    const s = answer.selected;
    return typeof s === "string" ? s : (s?.text ?? s?.value ?? null);
  }
  return null;
}

/**
 * Extract the picked member id from a decision response. Defensive: real
 * response shapes vary per provider (answers.pick_model vs answers vs results,
 * choice as string vs array vs object). Returns null when nothing parses.
 */
export function parseRouterDecisionResult(decision) {
  const answers = decision?.answers ?? decision?.result?.answers ?? decision?.result ?? decision;
  const pick = answers?.pick_model ?? (answers && typeof answers === "object" && !Array.isArray(answers)
    ? Object.values(answers)[0]
    : null);
  const raw = firstAnswerValue(pick);
  if (typeof raw !== "string") return null;
  return raw.trim() || null;
}

/**
 * Membership guard: the picked id must be one of the candidates. Off-vocab
 * answers (hallucinated model, extra prose, case drift on a bare-tail hit)
 * return null so the orchestrator degrades to the fallback order.
 */
export function guardRouterPick(picked, candidates = []) {
  if (typeof picked !== "string" || !picked) return null;
  if (candidates.includes(picked)) return picked;
  // Single safe normalization: a decision model that answers with the bare
  // model tail ("gemini-2.5-pro") instead of "provider/gemini-2.5-pro" hits
  // exactly one candidate → accept; ambiguous or zero → null.
  const hits = candidates.filter((c) => c.endsWith(`/${picked}`));
  return hits.length === 1 ? hits[0] : null;
}
