/*
 * Live E2E probe for LingxiExecutor — uses a real CreditDaddy cookie jar
 * and calls the executor exactly the way chatCore does (execute() with a
 * credentials shape), then asserts the OpenAI-shaped SSE output.
 * Read-only vs CreditDaddy: reads accounts.json, writes nothing back.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { LingxiExecutor } from "../../open-sse/executors/lingxi.js";

const dir = process.env.CREDITDADDY_HOME || path.join(os.homedir(), ".creditdaddy");
const accs = JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"));
const list = Array.isArray(accs) ? accs : accs.accounts || [];
const lx = list.filter((a) => a.provider === "lingxi");
if (!lx.length) {
  console.log("SKIP: no lingxi accounts in CreditDaddy");
  process.exit(0);
}
const cookie = lx[0].meta.cookieSiteSession.cookie;
console.log("using account:", lx[0].name);

const exec = new LingxiExecutor();
const log = {
  debug: (t, m) => console.log("[debug]", t, m),
  info: (t, m) => console.log("[info]", t, m),
  warn: (t, m) => console.log("[warn]", t, m),
  error: (t, m) => console.log("[error]", t, m),
};

const t0 = Date.now();
const { response, url } = await exec.execute({
  model: "kimi-k3",
  body: {
    messages: [
      { role: "system", content: "回答要简短。" },
      { role: "user", content: "用一句话介绍长江。" },
    ],
  },
  stream: true,
  credentials: { apiKey: cookie },
  signal: null,
  log,
});

console.log("url:", url);
console.log("status:", response.status, "ct:", response.headers.get("content-type"));

const raw = await response.text();
const chunks = raw.split("\n\n").filter((b) => b.startsWith("data: "));
let content = "";
let reasoning = "";
let finish = null;
let role = null;
for (const c of chunks) {
  const data = c.slice(6);
  if (data === "[DONE]") continue;
  let j;
  try { j = JSON.parse(data); } catch { continue; }
  if (j.error) { console.log("STREAM ERROR FRAME:", JSON.stringify(j.error)); }
  const ch = j.choices?.[0];
  if (ch?.delta?.role) role = ch.delta.role;
  if (typeof ch?.delta?.content === "string") content += ch.delta.content;
  if (typeof ch?.delta?.reasoning_content === "string") reasoning += ch.delta.reasoning_content;
  if (ch?.finish_reason) finish = ch.finish_reason;
}
console.log("elapsed:", Date.now() - t0, "ms | sse chunks:", chunks.length);
console.log("role:", role, "| finish:", finish);
console.log("reasoning len:", reasoning.length);
console.log("content:", content);

let ok = true;
if (role !== "assistant") { ok = false; console.log("FAIL: no assistant role chunk"); }
if (!content || content.length < 10) { ok = false; console.log("FAIL: empty/short content"); }
if (finish !== "stop") { ok = false; console.log("FAIL: finish_reason != stop"); }
if (content.includes("[Error:")) { ok = false; console.log("FAIL: error text in content"); }

// non-streaming turn too
const t1 = Date.now();
const r2 = await exec.execute({
  model: "qwen3.8_flash",
  body: { messages: [{ role: "user", content: "1+2等于几?只回答数字" }] },
  stream: false,
  credentials: { apiKey: cookie },
  signal: null,
  log,
});
const j2 = await r2.response.json();
console.log("non-stream status:", r2.response.status, "| content:", j2.choices?.[0]?.message?.content);
if (r2.response.status !== 200 || !/\d/.test(String(j2.choices?.[0]?.message?.content || ""))) {
  ok = false;
  console.log("FAIL: non-stream turn broken");
}
console.log("non-stream elapsed:", Date.now() - t1, "ms");

console.log(ok ? "\n=== LIVE E2E PASS ===" : "\n=== LIVE E2E FAIL ===");
process.exit(ok ? 0 : 1);
