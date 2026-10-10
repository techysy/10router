// P0 GOLDEN: lock buildUrl + buildHeaders cho mọi provider trên code CŨ.
// Sinh snapshot lần đầu (baseline) → sau refactor chạy lại phải khớp y hệt.
// Mock proxyFetch + uuid-heavy executors KHÔNG cần ở đây vì chỉ gọi buildUrl/buildHeaders (pure).
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

// Credentials mẫu cố định (deterministic) — KHÔNG dùng Date.now/random.
const API_KEY_CRED = { apiKey: "sk-test-APIKEY", providerSpecificData: {} };
const OAUTH_CRED = { accessToken: "tok-test-ACCESS", providerSpecificData: {} };
const SPECIAL_CRED = {
  apiKey: "sk-test-APIKEY",
  accessToken: "tok-test-ACCESS",
  providerSpecificData: { accountId: "ACC123", region: "sgp", baseUrl: "https://custom.example.com/v1", orgId: "ORG9" },
};

// Provider cần executor riêng (buildUrl/buildHeaders không nằm ở DefaultExecutor) → bỏ qua ở golden này.
// Chúng được lock riêng ở 11-provider edge tests / unit test chuyên biệt.
const SPECIALIZED = new Set([
  "antigravity", "azure", "gemini-cli", "github", "iflow", "qoder", "qoder-cn", "kiro",
  "codex", "cursor", "vertex", "vertex-partner", "opencode",
  "opencode-go", "grok-web", "perplexity-web", "ollama-local", "commandcode",
  "xiaomi-tokenplan", "mimo-free",
  // mimo-desktop 与 xiaomi-mimo 共用 XiaomiMimoExecutor，但不同于后者：它的**每一个**
  // 模型都是 preview，buildUrl/buildHeaders 永不走 DefaultExecutor 分支，所以在这里
  // 快照下来只会锁住一段永远不会执行的代码。xiaomi-mimo 之所以**不**排除，正是因为
  // 它的云模型确实走默认路径。真正会执行的桌面路径锁在 unit/xiaomi-mimo-executor.test.js。
  "mimo-desktop",
]);

// Phiên bản app được nướng vào vài header (đọc từ package.json lúc chạy):
//   `9Router/<ver>` (cline/clinepass) và `X-CLIENT-VERSION` / `X-CORE-VERSION` / `X-Msh-Version`.
// Bản test cục bộ mang số `X.Y.Z-test.N`, nên nếu không khử thì mỗi vòng test lại làm mismatch
// cline/clinepass/kimi — dù hình dạng header không đổi.
// CHỈ khử đúng các field mang phiên bản app: một regex `\d+\.\d+\.\d+` trần sẽ nuốt luôn
// `claude-cli/2.1.92` và `x-9r-core-version` của provider khác, tức snapshot khoá nhầm
// thứ không phải phiên bản của mình.
const APP_VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const APP_VERSION_HEADERS = new Set(["X-CLIENT-VERSION", "X-CORE-VERSION", "X-Msh-Version"]);

// Header keys whose VALUE is baked from the machine running the suite — not from
// code under test. The golden locks header SHAPE across refactors; freezing the
// generating host makes the committed snapshot unmatchable everywhere else:
//   cline/clinepass: X-PLATFORM (process.platform), X-PLATFORM-VERSION (process.version)
//   kimi: X-Msh-Device-Model (platform+arch), X-Msh-Device-Name (hostname)
// This is exactly how kimi went red on ubuntu CI after the 40→37 re-snapshot
// declared it green from a local Windows run. Whole-value replacement by key:
// deterministic regardless of host OS, node build or machine name.
const HOST_DERIVED_HEADERS = new Set([
  "X-PLATFORM", "X-PLATFORM-VERSION", "X-Msh-Device-Model", "X-Msh-Device-Name",
]);

// Sanitize header: khử token + field thời gian động (kimi X-Msh-Device-Id) để snapshot ổn định.
function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOST_DERIVED_HEADERS.has(k)) { out[k] = "<HOST>"; continue; }
    out[k] = typeof v === "string"
      ? v.replace(/Bearer .+/, "Bearer <TOK>")
          .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
          .replace(/kimi-\d{10,}/g, "kimi-<TS>")
          .replace(/9Router\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/, "9Router/<VER>")
          .replace(APP_VERSION_HEADERS.has(k) ? APP_VERSION_RE : /(?!)/, "<VER>")
      : v;
  }
  return out;
}

const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

describe("GOLDEN buildUrl (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → url (stream + non-stream)`, () => {
      const ex = new DefaultExecutor(pid);
      const cred = PROVIDERS[pid].noAuth ? {} : SPECIAL_CRED;
      const model = "test-model";
      const snap = {
        stream: safe(() => ex.buildUrl(model, true, 0, cred)),
        nonStream: safe(() => ex.buildUrl(model, false, 0, cred)),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

describe("GOLDEN buildHeaders (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → headers (apiKey / oauth)`, () => {
      const ex = new DefaultExecutor(pid);
      const snap = {
        apiKey: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true))),
        oauth: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true))),
        nonStream: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false))),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}
