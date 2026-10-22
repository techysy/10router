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

// Health is used as an EXCLUSION signal, not a ranking score.
//
// It used to be rendered as "health 91/100 (success 97%)" on members with
// recent traffic and omitted entirely on cold ones. That asymmetry is worse
// than no signal at all: a decision model reading "one member scores 91, the
// other says nothing" reliably prefers the scored one, so a model that has not
// been called yet is penalised for the crime of being new — and then never
// gets called, so it never acquires data. Self-reinforcing starvation.
//
// So the card only ever calls out the one thing health can honestly say:
// "this member has been failing lately". Members with good health and members
// with no data look identical (both unmarked), which is exactly the state of
// knowledge at decision time.
export const FLAKY_HEALTH_THRESHOLD = 70;

/**
 * Build the decision payload from the chat body + candidate member list.
 *   state     = last user turn + tool-call intent + a one-line per-member card
 *   questions = one `choice` question: which member should answer
 *
 * Member descriptions come from the resolved model info (name / provider /
 * capabilities) plus an optional "recently flaky" mark (see
 * FLAKY_HEALTH_THRESHOLD). Members without traffic data are never marked and
 * never described as low quality. The answer vocabulary is the exact
 * candidate ids — anything outside is guarded downstream and degrades to
 * fallback.
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
    // Exclusion signal only (see FLAKY_HEALTH_THRESHOLD): a member is marked
    // just when recent traffic says it is failing. Healthy members and members
    // with no data are both unmarked — never fabricate a number, and never
    // make "no data" look like "bad data".
    const flaky = info?.health != null && info.health < FLAKY_HEALTH_THRESHOLD;
    const mark = flaky
      ? ` [recently flaky: ${info.health}/100 over recent traffic${info.successRate != null ? `, ${info.successRate}% success` : ""}]`
      : "";
    const label = clampText(info?.name || m, 80);
    return `- ${m} (${label}${ctx ? `,${ctx}` : ""}${caps.length ? `, ${caps.join("/")}` : ""})${mark}`;
  });

  const stateParts = [
    intent ? `User request: ${intent}` : "User request: (no text content in this turn)",
    `Client expects: ${streaming ? "streaming" : "non-streaming"} reply${wantsTools ? "; tool/function calling in play" : ""}`,
    tools.length ? `Tools offered: ${tools.join(", ")}` : "",
    `Candidate models (pick exactly one id):\n${memberLines.join("\n")}`,
    // Explicit decision rule. Without it the model tends to invent its own
    // ranking over whatever attributes happen to be present; the rule below
    // says the only negative signal is the flaky mark, so an unmarked member
    // is a first-class choice rather than a last resort.
    "How to choose: prefer a member whose capabilities fit the request (tool calling, vision, pdf, context size). "
      + "A member marked [recently flaky] should be avoided when an equally capable unmarked member exists. "
      + "Unmarked members either have good recent health or no recent traffic data — absence of a mark is NOT a quality penalty.",
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
 * Decision confidence, for the log line only — never for routing.
 *
 * A System One `choice` answer carries `confidence` and a per-label
 * `probabilities` map. The pick is the same whether or not we read them, so
 * this must stay out of the decision path: it exists because "→ member A" on
 * its own cannot distinguish a 0.98 certainty from a 0.34 coin-flip over a
 * near-tie, which is exactly what you need to know when tuning a combo.
 *
 * Defensive like the parser above: providers differ in shape and a missing or
 * malformed block must not affect routing.
 *
 * @returns {{confidence: number|null, runnerUp: string|null, runnerUpP: number|null} | null}
 */
export function parseRouterDecisionMeta(decision) {
  try {
    const answers = decision?.answers ?? decision?.result?.answers ?? decision?.result ?? decision;
    const pick = answers?.pick_model ?? (answers && typeof answers === "object" && !Array.isArray(answers)
      ? Object.values(answers)[0]
      : null);
    if (!pick || typeof pick !== "object") return null;

    const chosen = firstAnswerValue(pick);
    const conf = typeof pick.confidence === "number" && Number.isFinite(pick.confidence)
      ? pick.confidence
      : null;

    // Best alternative, when the upstream returned a distribution. Lets the log
    // show "0.52 (next: B 0.41)" — a close second means the pick is unstable.
    let runnerUp = null;
    let runnerUpP = null;
    const probs = pick.probabilities;
    if (probs && typeof probs === "object" && !Array.isArray(probs)) {
      for (const [label, p] of Object.entries(probs)) {
        if (label === chosen || typeof p !== "number" || !Number.isFinite(p)) continue;
        if (runnerUpP === null || p > runnerUpP) {
          runnerUp = label;
          runnerUpP = p;
        }
      }
    }

    if (conf === null && runnerUp === null) return null;
    return { confidence: conf, runnerUp, runnerUpP };
  } catch {
    return null;
  }
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
