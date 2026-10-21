// CodeArts (Huawei Cloud CodeArts Agent) — AKSK + STS signed chat provider.
//
// Chat is OpenAI-shaped on `snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions`,
// but every request is signed (SDK-HMAC-SHA256) and the auth material is a
// temporary AK/SK/STS triple from Huawei STS. That is why this is an executor
// provider, not a plain OpenAI baseUrl: the signature covers the body and every
// header (including `maas_type: benefit`).
//
// Catalog: three live sources merged agent-first, then builtin, then the
// benefit gateway (Rust models.rs). The static seed below is that union as
// measured on 2026-10 — the live `/v1/model/builtin` + agent `/detail` reads can
// add models at runtime. Model ids are case-sensitive upstream (`GLM-5.2` ≠
// `glm-5.2`); the executor normalises case before sending.
//
// Output: every model declares `maxOutput: 65536` even where the catalog says
// 131072/393216. The upstream rejects 65537+ wholesale
// (`InferHub.001001005.400`), so the catalog numbers are not usable as limits.
//
// OAuth (PKCE + ES256 DPoP + STS) is a TODO: the helper skeleton lives in
// `open-sse/shared/codearts/{signing,oauth}.js`, but no `src/lib/oauth/provider`
// is wired yet, so the only supported onboarding today is manual AK/SK import.
import { CODEARTS_BASE_URL, CODEARTS_CHAT_URL, CODEARTS_MODELS } from "../../config/codearts.js";

export { CODEARTS_MODELS };

export default {
  id: "codearts",
  alias: "codearts",
  uiAlias: "ca",
  aliases: ["ca"],
  category: "oauth",
  authType: "apikey",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "华为云 CodeArts：手动导入临时 AK/SK（OAuth 登录待接入）",
  display: {
    name: "CodeArts",
    icon: "cloud",
    color: "#C7000B",
    textIcon: "CA",
    website: "https://codearts.huaweicloud.com",
    notice: {
      signupUrl: "https://codearts.huaweicloud.com",
    },
  },
  transport: {
    baseUrl: CODEARTS_CHAT_URL,
    format: "openai",
    // Functional identity: upstream signs/validates these headers too.
    headers: {
      "X-Language": "en-us",
      "plugin-name": "snap_vscode",
      "plugin-version": "1.0.0",
    },
    timeoutMs: 300_000,
    stallTimeoutMs: 180_000,
    usage: {
      url: `${CODEARTS_BASE_URL}/snap-manager/v1/statistics/plugin`,
    },
  },
  models: CODEARTS_MODELS,
  features: {
    usage: true,
    usageApikey: true,
  },
};
