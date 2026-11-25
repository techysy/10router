#!/usr/bin/env node
/**
 * Headless-browser UI driver (Chrome DevTools Protocol, zero dependencies).
 *
 * Why this exists: the dashboard has a class of bugs that code reading cannot
 * catch and unit tests cannot reproduce — a stale-closure race that only shows
 * up when several buttons in one card are clicked in the same tick, a count
 * that keeps reporting the server's page after a client-side filter trimmed the
 * grid, an icon that contradicts the label printed next to it. Each of those
 * was found by driving the real running app and reading its DOM, and each was
 * missed (or mis-diagnosed) by reading the source.
 *
 * It talks CDP over Node's built-in global WebSocket (Node >= 22), so there is
 * nothing to install. It starts its own headless Chrome against the app the
 * local test round just deployed (default http://localhost:20128), evaluates a
 * script in the page, prints the result, and saves a screenshot.
 *
 * Usage:
 *   node scripts/browser-probe.mjs <url> [options]
 *
 *   --script <file>   JS file evaluated in the page after load. Its completion
 *                     value is reported; an `async` IIFE is the usual shape
 *                     (top-level await is supported because the expression is
 *                     awaited). Omit to just load + screenshot.
 *   --out <file>      screenshot path (default: browser-probe.png in cwd)
 *   --wait <ms>       settle time after load before evaluating (default 4000)
 *   --json <file>     also write {url, evalResult} as JSON, without console noise
 *   --keep-open       do not kill Chrome on exit (inspect DevTools yourself)
 *   --chrome <path>   Chrome/Edge binary (default: auto-detect)
 *
 * Examples:
 *   # verify the quota page's toolbar state after a build was deployed
 *   node scripts/browser-probe.mjs http://localhost:20128/dashboard/quota \
 *     --script scripts/probes/quota-toolbar.js --json result.json
 *
 * Notes / traps learned the hard way:
 *   - `--headless=new` is required; old headless has no real layout, so
 *     getBoundingClientRect and "is this button visible" probes lie.
 *   - A fresh --user-data-dir each run keeps a stale localStorage preference
 *     from silently changing what the page renders between runs. Pass
 *     --profile to reuse one on purpose.
 *   - Console output is captured (Runtime.consoleAPICalled) and reported, which
 *     is where app-side `[ProviderLimits] ...` diagnostics show up.
 *   - Writing the JSON via --json (not a shell redirect) matters on Windows:
 *     PowerShell's `>` writes UTF-16/BOM and JSON.parse then fails.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function parseArgs(argv) {
  const opts = { wait: 4000, port: 9333, keepOpen: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--script") opts.script = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--wait") opts.wait = Number(argv[++i]);
    else if (a === "--json") opts.json = argv[++i];
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--profile") opts.profile = argv[++i];
    else if (a === "--chrome") opts.chrome = argv[++i];
    else if (a === "--keep-open") opts.keepOpen = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else positional.push(a);
  }
  opts.url = positional[0];
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.url) {
  console.log(
    "usage: node scripts/browser-probe.mjs <url> [--script f.js] [--out shot.png]\n" +
      "       [--wait ms] [--json out.json] [--port n] [--profile dir] [--keep-open]",
  );
  process.exit(opts.help ? 0 : 2);
}

const chromePath = opts.chrome || CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error(
    "No Chrome/Edge found. Pass --chrome <path> or set CHROME_PATH.",
  );
  process.exit(2);
}

const outPng = resolve(opts.out || "browser-probe.png");
const profile =
  opts.profile || join(tmpdir(), `browser-probe-${process.pid}-${Date.now()}`);
mkdirSync(profile, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${opts.port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-proxy-server",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1600,1400",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let version = null;
for (let i = 0; i < 80; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${opts.port}/json/version`)).json();
    break;
  } catch {
    await sleep(250);
  }
}
if (!version) {
  child.kill();
  console.error("Chrome did not expose a debugging endpoint in time.");
  process.exit(2);
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("CDP websocket failed to open"));
});

let nextId = 1;
const pending = new Map();
const consoleLogs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject: rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(JSON.stringify(msg.error)));
    else res(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    consoleLogs.push({
      type: msg.params.type,
      text: msg.params.args
        .map((a) => a.value ?? a.description ?? a.type)
        .join(" "),
    });
  }
  if (msg.method === "Runtime.exceptionThrown") {
    consoleLogs.push({
      type: "pageerror",
      text:
        msg.params.exceptionDetails?.exception?.description ||
        msg.params.exceptionDetails?.text ||
        "page error",
    });
  }
};

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}

function cleanup() {
  try { ws.close(); } catch {}
  if (!opts.keepOpen) {
    try { child.kill(); } catch {}
  }
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", {
  targetId,
  flatten: true,
});
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Page.navigate", { url: opts.url }, sessionId);
await sleep(opts.wait);

let evalResult = null;
if (opts.script) {
  const expression = readFileSync(resolve(opts.script), "utf8");
  const r = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  evalResult = r.exceptionDetails
    ? {
        exception:
          r.exceptionDetails.exception?.description || r.exceptionDetails.text,
      }
    : (r.result?.value ?? r.result?.description ?? null);
}

const shot = await send(
  "Page.captureScreenshot",
  { format: "png", captureBeyondViewport: true },
  sessionId,
);
writeFileSync(outPng, Buffer.from(shot.data, "base64"));

const report = { url: opts.url, outPng, evalResult, consoleLogs };
if (opts.json) {
  writeFileSync(resolve(opts.json), JSON.stringify(report, null, 2), "utf8");
}
console.log(JSON.stringify(report, null, 2));

if (!opts.keepOpen) await send("Target.closeTarget", { targetId }).catch(() => {});
cleanup();
process.exit(evalResult && evalResult.exception ? 1 : 0);
