// OfficeAce (华为云果办 / OfficeClaw) — Huawei Cloud's office copilot gateway.
//
// Two auth planes, deliberately staged:
//
//   1. THIS FILE (shipped): `category:"apikey"`. The user imports the gateway
//      Basic pair by hand as `model_app_key:model_app_secret` (apiKey field).
//      Transport is the per-account model gateway
//      `https://modelgw-00NN.<region>.huaweicloud-agentarts.com/v2/chat/completions`.
//      The pair does not expire, so there is no refresh path.
//
//   2. TODO (follow-up PR): OAuth. PKCE + P-256 DPoP → STS (2h) → exchange for
//      the non-expiring gateway Basic pair. That chain also needs a token state
//      machine (`usedToken` / `consumed` / `deadTokens`, STS 5.1806/1807 mark a
//      ticket dead, persist BEFORE mutating memory) and per-account single-flight
//      (a module-level boolean would stall the whole pool). Until it lands,
//      connections are created by manual import only.
//
// The control plane (`/v1/subscription*`, usage + bonus claim) needs AK/SK/STS
// and V11-HMAC signing, which a Basic-only connection does not carry; the usage
// handler and the check-in adapter say so explicitly instead of failing quietly.
//
// Model ids below are a seed, not the catalog: `GET {gateway}/v1/models` is
// per-account and several listed names answer 81004/81009 upstream. Unknown
// ids are forwarded (no strictModels) — probing/aliasing (81009) is follow-up.
import {
  OFFICEACE_DEFAULT_GATEWAY_BASE,
  OFFICEACE_MODELS,
  officeaceChatEndpoint,
} from "../../config/officeace.js";

export default {
  id: "officeace",
  alias: "oac",
  uiAlias: "oac",
  category: "oauth",
  authType: "apikey",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "手工导入网关 Basic 对：model_app_key:model_app_secret（OAuth 后续）",
  display: {
    name: "OfficeAce",
    icon: "workspaces",
    color: "#C7000B",
    textIcon: "OA",
    website: "https://www.huaweicloud.com/product/officeace.html",
    notice: {
      apiKeyUrl: "https://www.huaweicloud.com/product/officeace.html",
    },
  },
  transport: {
    baseUrl: officeaceChatEndpoint(OFFICEACE_DEFAULT_GATEWAY_BASE),
    format: "openai",
    // The Basic header is built by executors/officeace.js from `key:secret`;
    // "raw" keeps the registry honest about not being a Bearer provider.
    auth: { header: "Authorization", scheme: "raw", source: ["apiKey"] },
    // The gateway always streams; non-streaming clients are aggregated locally.
    forceStream: true,
  },
  models: OFFICEACE_MODELS,
  features: {
    usage: true,
  },
};
