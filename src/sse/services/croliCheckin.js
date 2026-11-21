// Croli task-center reads and explicit check-in. Conversation/import progress is
// never fabricated here; successful user chats report their own event.
import { randomUUID } from "node:crypto";
import * as log from "../utils/logger.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";
import { CROLI_CONFIG } from "@/lib/oauth/constants/oauth.js";
import { fetchCroliOpsHome } from "../../../open-sse/services/croli.js";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/db/index.js";

const TURN_EVENT = "agent_turn_completed";
const TURN_EVENT_STATE = "croliTurnEventState";
const TASK_LABELS = { checkin: "Daily check-in", agent_turn_completed: "First chat today", conversations_imported: "First session import" };
const inflight = new Map();
const asNumber = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value)) ? Number(value) : null;
export const croliDayKey = (now = Date.now()) => new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

export function isEligibleCroliConnection(connection) {
  return Boolean(connection && connection.provider === "croli" && connection.authType === "oauth"
    && connection.isActive !== false && typeof connection.accessToken === "string" && connection.accessToken.trim());
}

function tasksOf(home) {
  return (Array.isArray(home?.programs) ? home.programs : [])
    .filter((program) => !program.status || program.status === "active")
    .flatMap((program) => Array.isArray(program.tasks) ? program.tasks : []);
}

export function describeCroliTask(task) {
  const label = (typeof task?.name === "string" && task.name.trim()) || (typeof task?.title === "string" && task.title.trim())
    || TASK_LABELS[task?.eventKey] || task?.key || "Croli task";
  const progress = asNumber(task?.progress) ?? 0;
  const target = asNumber(task?.target) || 1;
  const reported = asNumber(task?.reportedProgress);
  const milestones = Array.isArray(task?.milestones) ? task.milestones : [];
  if (task?.status === "pending_verification") return { task: task.key || String(task.id), label, status: "pending", progress, reported, target,
    note: `Croli received ${reported ?? progress}/${target}; waiting for server verification.` };
  if (task?.status === "claimed" || milestones.some((milestone) => milestone.status === "claimed")) return {
    task: task.key || String(task.id), label, status: "done", progress, reported, target,
    note: task.frequency === "once" || task.periodKey === "all" ? "Claimed (one-time)." : "Claimed for this period.",
  };
  if (milestones.some((milestone) => milestone.status === "claimable")) return {
    task: task.key || String(task.id), label, status: "claimable", progress, reported, target,
    note: "Croli marks a reward claimable.",
  };
  return {
    task: task.key || String(task.id), label,
    status: progress >= target ? "completed" : "pending", progress, reported, target,
    note: progress >= target ? "Target reached; waiting for Croli settlement." : `Progress ${progress}/${target}; complete the task normally.`,
  };
}

function errorInfo(error, resource) {
  const status = Number(error?.status) || 0;
  const code = typeof error?.code === "string" ? error.code : status ? `http_${status}` : "network_error";
  const message = status === 401 || status === 403 ? "Croli credentials are unavailable; reconnect this account."
    : String(error?.message || "Croli request failed").slice(0, 240);
  return { status, code, message, ...(resource ? { resource } : {}) };
}

async function requestCroliJson(connection, endpoint, { method = "GET", body, proxyOptions, fetchImpl = proxyAwareFetch } = {}) {
  if (!connection?.accessToken) throw Object.assign(new Error("Croli OAuth token is missing."), { status: 401, code: "missing_access_token" });
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method,
      headers: { Authorization: `Bearer ${connection.accessToken}`, Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error", signal: AbortSignal.timeout(20_000),
    }, proxyOptions || null);
  } catch {
    throw Object.assign(new Error("Croli request could not connect."), { status: 0, code: "connection_failed" });
  }
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const code = response.status === 401 ? "authentication_failed" : response.status === 403 ? "access_denied"
      : response.status === 404 && (data?.code === "account_not_found" || data?.error === "account_not_found") ? "account_not_found" : `http_${response.status}`;
    throw Object.assign(new Error(code === "authentication_failed" || code === "access_denied"
      ? "Croli credentials are unavailable; reconnect this account." : `Croli request failed (${code}).`), { status: response.status, code });
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.error || data.success === false) {
    throw Object.assign(new Error("Croli returned an invalid response."), { status: 502, code: "invalid_response" });
  }
  return data;
}

function rowsOf(value) {
  if (Array.isArray(value)) return value;
  for (const key of ["items", "entries", "ledger", "records"]) if (Array.isArray(value?.[key])) return value[key];
  return [];
}
const ledgerId = (row) => row?.id ?? row?.entryId ?? row?.ledgerId ?? null;
const ledgerCredits = (row) => asNumber(row?.creditsDelta ?? row?.delta ?? row?.credits ?? row?.amount) || 0;
function ledgerDifference(before, after) {
  if (!before || !after || before.some((row) => ledgerId(row) === null) || after.some((row) => ledgerId(row) === null)) return null;
  const previousIds = new Set(before.map((row) => String(ledgerId(row))));
  return after.filter((row) => !previousIds.has(String(ledgerId(row))) && ledgerCredits(row) > 0);
}
function ledgerForDisplay(value) {
  return rowsOf(value).slice(0, 20).map((row) => ({
    reason: typeof row?.reason === "string" ? row.reason.slice(0, 80) : "credit",
    credits: ledgerCredits(row),
    at: typeof row?.createdAt === "string" ? row.createdAt : typeof row?.created_at === "string" ? row.created_at : null,
  })).filter((row) => row.credits > 0);
}

async function readAccount(connection, options = {}) {
  const result = { connectionId: connection.id, account: connection.email || connection.displayName || connection.name || connection.id,
    provider: "croli", status: "observed", claimedAmount: 0, items: [], errors: [], at: new Date((options.now || Date.now)()) };
  if (!connection.accessToken) {
    result.status = "failed"; result.errors.push(errorInfo({ status: 401, code: "missing_access_token" }));
    return { result, home: null, ledger: null };
  }
  const specs = [
    ["home", () => fetchCroliOpsHome(connection.accessToken, { fetchImpl: options.fetchImpl || proxyAwareFetch,
      proxyOptions: options.proxyOptions, ensureAccount: options.ensureAccount === true }), CROLI_CONFIG.opsHomeUrl],
    ["balance", () => requestCroliJson(connection, CROLI_CONFIG.balanceUrl, options), CROLI_CONFIG.balanceUrl],
    ["ledger", () => requestCroliJson(connection, CROLI_CONFIG.ledgerUrl, options), CROLI_CONFIG.ledgerUrl],
  ];
  const entries = await Promise.all(specs.map(async ([key, run, endpoint]) => {
    try { return [key, { data: await run() }]; }
    catch (error) { return [key, { error: errorInfo(error, endpoint) }]; }
  }));
  const reads = Object.fromEntries(entries);
  for (const value of Object.values(reads)) if (value.error) result.errors.push(value.error);
  const balance = asNumber(reads.balance?.data?.balance);
  if (balance !== null) result.balance = balance;
  if (reads.balance?.data?.trial && typeof reads.balance.data.trial === "object") result.trial = reads.balance.data.trial;
  if (reads.ledger?.data) result.ledger = ledgerForDisplay(reads.ledger.data);
  result.items = tasksOf(reads.home?.data).map(describeCroliTask);
  if (result.errors.length) result.status = "partial";
  return { result, home: reads.home?.data || null, ledger: reads.ledger?.data ? rowsOf(reads.ledger.data) : null };
}

function uniqueErrors(errors) {
  const seen = new Set();
  return (Array.isArray(errors) ? errors : []).filter((entry) => {
    const key = `${entry?.code || ""}|${entry?.message || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index]); }
  }));
  return results;
}
async function connectionsFor(id) {
  const { getProviderConnections } = await import("@/lib/db/index.js");
  const rows = await getProviderConnections({ provider: "croli" });
  return (rows || []).filter((connection) => connection.provider === "croli" && (!id || connection.id === id));
}
function inviteFrom(settings, id) {
  const code = settings?.croliInviteCodes?.[id]?.code;
  return typeof code === "string" && /^[A-Z0-9]{6,32}$/.test(code)
    ? { code, link: `https://www.croli.net/invite/?code=${encodeURIComponent(code)}` } : null;
}
async function saveResults(results, connections, trigger) {
  const { mutateSettingsMap } = await import("@/lib/db/repos/settingsRepo.js");
  const ids = new Set(connections.map((connection) => connection.id));
  let saved = [];
  await mutateSettingsMap("croliLastClaim", (current) => {
    const byId = new Map((Array.isArray(current.results) ? current.results : [])
      .filter((row) => row?.connectionId && ids.has(row.connectionId)).map((row) => [row.connectionId, row]));
    for (const row of results) if (row?.connectionId && !row.memoized) byId.set(row.connectionId, row);
    saved = connections.map((connection) => byId.get(connection.id)).filter(Boolean);
    return { at: new Date().toISOString(), trigger, results: saved };
  });
  return saved;
}
async function proxyFor(connection) {
  const { resolveConnectionProxyConfig } = await import("@/lib/network/connectionProxy.js");
  const config = await resolveConnectionProxyConfig(connection?.providerSpecificData || {});
  return { connectionProxyEnabled: config.connectionProxyEnabled === true, connectionProxyUrl: config.connectionProxyUrl || "",
    connectionNoProxy: config.connectionNoProxy || "", vercelRelayUrl: config.vercelRelayUrl || "", strictProxy: false };
}

export async function readCroliCredits(deps = {}) {
  const { getSettings } = await import("@/lib/db/index.js");
  const [settings, connections] = await Promise.all([getSettings(), connectionsFor(deps.connectionId)]);
  const results = await mapLimit(connections, 3, async (connection) => {
    const result = await readAccount(connection, { ...deps, proxyOptions: deps.proxyOptions || await proxyFor(connection) });
    result.result.invite = inviteFrom(settings, connection.id);
    return result.result;
  });
  return { success: true, autoCheckin: settings.croliCheckin === true, results, at: new Date().toISOString() };
}

export async function checkinCroliTasks(connection, deps = {}) {
  if (!isEligibleCroliConnection(connection)) throw Object.assign(new Error("Croli account is inactive or has no OAuth token."), { status: 401, code: "ineligible_connection" });
  const proxyOptions = deps.proxyOptions || await proxyFor(connection);
  const before = await readAccount(connection, { ...deps, proxyOptions, ensureAccount: true });
  const result = before.result;
  if (!before.home) return result;
  const operations = [];
  for (const task of tasksOf(before.home)) {
    if (task.isPastPeriod) continue;
    if (task.eventKey === "checkin" && task.status !== "claimed"
        && (asNumber(task.progress) || 0) < (asNumber(task.target) || 1)) {
      operations.push([CROLI_CONFIG.checkinUrl, { taskId: task.id }]);
    }
    for (const milestone of task.milestones || []) if (milestone.status === "claimable" && task.id != null && task.periodKey) {
      operations.push([`${CROLI_CONFIG.creditsBaseUrl}/v1/ops/tasks/${encodeURIComponent(task.id)}/claim`,
        { milestoneIndex: milestone.index, periodKey: task.periodKey }]);
    }
  }
  for (const [url, body] of operations) {
    try { await requestCroliJson(connection, url, { method: "POST", body, proxyOptions, fetchImpl: deps.fetchImpl || proxyAwareFetch }); }
    catch (error) { result.errors.push(errorInfo(error, url)); }
  }
  if (!operations.length) { result.status = result.errors.length ? "partial" : "already"; return result; }
  const after = await readAccount(connection, { ...deps, proxyOptions });
  const added = ledgerDifference(before.ledger, after.ledger);
  after.result.errors = uniqueErrors([...after.result.errors, ...result.errors]);
  after.result.claimedAmount = added === null ? 0 : added.reduce((sum, row) => sum + ledgerCredits(row), 0);
  after.result.status = after.result.errors.length ? "partial" : added === null ? "claim-unverified" : after.result.claimedAmount > 0 ? "checked-in" : "already";
  after.result.message = added === null ? "The credit ledger did not confirm whether new credits were added."
    : after.result.claimedAmount > 0 ? "New credits confirmed by the credit ledger." : "No new credits found in the credit ledger.";
  return after.result;
}

export async function runCroliCheckinTick(deps = {}) {
  const { getSettings } = await import("@/lib/db/index.js");
  const [settings, connections] = await Promise.all([getSettings(), connectionsFor(deps.connectionId)]);
  const previous = new Map((settings.croliLastClaim?.results || []).map((row) => [row.connectionId, row]));
  const results = await mapLimit(connections, 2, async (connection) => {
    if (!isEligibleCroliConnection(connection)) return { connectionId: connection.id, account: connection.email || connection.name || connection.id,
      provider: "croli", status: "skipped", items: [], errors: [], claimedAmount: 0, at: new Date().toISOString() };
    const old = previous.get(connection.id);
    if (deps.skipIfCheckedToday && old && ["checked-in", "already"].includes(old.status)
      && Number.isFinite(Date.parse(old.at)) && croliDayKey(Date.parse(old.at)) === croliDayKey(deps.nowMs ?? Date.now())) return { ...old, memoized: true };
    try { return await checkinCroliTasks(connection, deps); }
    catch (error) { return { connectionId: connection.id, account: connection.email || connection.name || connection.id, provider: "croli",
      status: "failed", claimedAmount: 0, items: [], at: new Date().toISOString(), errors: [errorInfo(error)] }; }
  });
  await saveResults(results.filter((row) => !row.memoized), connections, deps.trigger || "manual");
  return results;
}

export async function generateCroliInvite(connectionId, deps = {}) {
  if (typeof connectionId !== "string" || !connectionId) throw Object.assign(new Error("Choose a Croli account."), { status: 400, code: "missing_connection" });
  const [connections, db] = await Promise.all([connectionsFor(), import("@/lib/db/index.js")]);
  const connection = connections.find((row) => row.id === connectionId);
  if (!isEligibleCroliConnection(connection)) throw Object.assign(new Error("Active Croli account not found."), { status: 404, code: "connection_not_found" });
  const data = await requestCroliJson(connection, CROLI_CONFIG.inviteCodeUrl, { method: "POST", body: { rotate: false },
    proxyOptions: deps.proxyOptions || await proxyFor(connection), fetchImpl: deps.fetchImpl || proxyAwareFetch });
  const code = typeof data.inviteCode === "string" && /^[A-Z0-9]{6,32}$/.test(data.inviteCode) ? data.inviteCode : null;
  if (!code) throw Object.assign(new Error("Croli returned an invalid invite code."), { status: 502, code: "invalid_invite_code" });
  const invite = { code, link: `https://www.croli.net/invite/?code=${encodeURIComponent(code)}`,
    inviterRewardCredits: asNumber(data.inviterRewardCredits), inviteeRewardCredits: asNumber(data.inviteeRewardCredits) };
  await db.mutateSettingsMap("croliInviteCodes", (current) => ({
    ...current, [connection.id]: { account: connection.email || connection.name || connection.id, ...invite, at: new Date().toISOString() },
  }));
  return { success: true, connectionId: connection.id, invite };
}

export async function reportCroliCompletedUserTurn(connectionId, deps = {}) {
  if (typeof connectionId !== "string" || !connectionId) return { status: "skipped" };
  const prior = inflight.get(connectionId) || Promise.resolve();
  const pending = prior.catch(() => undefined).then(async () => {
    const connection = await getProviderConnectionById(connectionId);
    if (!isEligibleCroliConnection(connection)) return { status: "skipped" };
    const proxyOptions = deps.proxyOptions || await proxyFor(connection);
    const home = await fetchCroliOpsHome(connection.accessToken, { fetchImpl: deps.fetchImpl || proxyAwareFetch, proxyOptions, ensureAccount: false });
    const openTask = tasksOf(home).some((task) => task.eventKey === TURN_EVENT && !task.isPastPeriod
      && task.status !== "pending_verification" && (asNumber(task.progress) || 0) < (asNumber(task.target) || 1));
    if (!openTask) return { status: "not-claimable" };
    const eventState = connection.providerSpecificData?.[TURN_EVENT_STATE] || {};
    const stored = typeof eventState.pendingEventId === "string" ? eventState.pendingEventId : null;
    const eventId = stored || randomUUID();
    if (!stored) await updateProviderConnection(connection.id, { providerSpecificData: { ...connection.providerSpecificData,
      [TURN_EVENT_STATE]: { ...eventState, pendingEventId: eventId } } });
    const data = await requestCroliJson(connection, CROLI_CONFIG.eventsUrl, { method: "POST", proxyOptions,
      fetchImpl: deps.fetchImpl || proxyAwareFetch,
      body: { eventKey: TURN_EVENT, eventId, metadata: { source: "completed_user_chat" } } });
    if (data.accepted === false) throw Object.assign(new Error("Croli did not accept the completed-chat event."), { code: "event_not_accepted", status: 502 });
    const latest = await getProviderConnectionById(connection.id);
    if (latest) await updateProviderConnection(connection.id, { providerSpecificData: { ...latest.providerSpecificData,
      [TURN_EVENT_STATE]: { ...(latest.providerSpecificData?.[TURN_EVENT_STATE] || {}), pendingEventId: null,
        lastAcceptedEventAt: new Date().toISOString() } } });
    return { status: "reported" };
  });
  inflight.set(connectionId, pending);
  try { return await pending; }
  catch (error) { deps.log?.warn?.("CROLI_EVENTS", `Completed-user-chat event failed (${error?.code || "upstream_error"})`); return { status: "failed" }; }
  finally { if (inflight.get(connectionId) === pending) inflight.delete(connectionId); }
}

let schedulerStarted = false;
let schedulerTimer = null;
let schedulerInFlight = null;
const SCHEDULER_INTERVAL_MS = 2 * 60 * 60 * 1000;
async function scheduledTick() {
  if (schedulerInFlight) return schedulerInFlight;
  schedulerInFlight = (async () => {
    const settings = await (await import("@/lib/db/index.js")).getSettings();
    if (settings.croliCheckin !== true) return;
    await runCroliCheckinTick({ skipIfCheckedToday: true, trigger: "auto" });
  })().catch((error) => log.warn("CROLI_CHECKIN", `Scheduled check failed (${error?.code || "upstream_error"})`))
    .finally(() => { schedulerInFlight = null; });
  return schedulerInFlight;
}
function scheduleTick() {
  if (!schedulerStarted) return;
  schedulerTimer = setTimeout(async () => { schedulerTimer = null; await scheduledTick(); scheduleTick(); }, SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref?.();
}
export function startCroliCheckin() {
  if (schedulerStarted || typeof window !== "undefined") return false;
  schedulerStarted = true;
  scheduleTick();
  return true;
}
export function stopCroliCheckin() {
  if (!schedulerStarted) return false;
  schedulerStarted = false;
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  return true;
}
export function _resetCroliCheckinState() {
  inflight.clear();
  stopCroliCheckin();
  schedulerInFlight = null;
}
