// AtomCode (AtomGit / GitCode) — CodingPlan plus AI Hub behind one OAuth
// account. Device-style browser login is brokered by acs.atomgit.com (no local
// callback), so this is an oauth-category provider that also accepts an API key.
//
// Two model pools, two quotas:
//   - CodingPlan (A pool): rolling CALL-COUNT windows (`status-v2`). These ids
//     are NOT in `/v1/models` yet they answer on the same gateway.
//   - AI Hub (B pool): what `/v1/models` lists; monthly token quota.
// The static seed below is the union (see shared/atomcode/catalog.js).
//
// Chat transport is api-ai.gitcode.com, the unsigned first-party gateway. Do
// not "align" it with the official llm-api.atomgit.com default: that host
// requires the closed-source signature.
import {
  ATOMCODE_MODELS,
  ATOMCODE_AI_HUB_MODELS,
  ATOMCODE_CODING_PLAN_MODELS,
  mergeAtomcodeModels,
  resolveAtomcodeModelId,
} from "../../shared/atomcode/catalog.js";
import {
  ATOMCODE_ADAPTER_USER_AGENT,
  ATOMCODE_BROKER_CHECK_PATH,
  ATOMCODE_BROKER_LOGIN_PATH,
  ATOMCODE_BROKER_REFRESH_PATH,
  ATOMCODE_BROKER_TOKEN_PATH,
  ATOMCODE_CODINGPLAN_STATUS_PATH,
  ATOMCODE_DEFAULT_BROKER_BASE,
  ATOMCODE_DEFAULT_CODINGPLAN_BASE,
  ATOMCODE_DEFAULT_GATEWAY_BASE,
  ATOMCODE_CHAT_TIMEOUT_MS,
} from "../../shared/atomcode/constants.js";

export {
  ATOMCODE_MODELS,
  ATOMCODE_AI_HUB_MODELS,
  ATOMCODE_CODING_PLAN_MODELS,
  mergeAtomcodeModels,
  resolveAtomcodeModelId,
};

const BROKER = ATOMCODE_DEFAULT_BROKER_BASE;
const CODINGPLAN = ATOMCODE_DEFAULT_CODINGPLAN_BASE;

export default {
  id: "atomcode",
  alias: "atc",
  uiAlias: "atc",
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "OAuth via AtomGit (acs.atomgit.com) or an AtomGit bearer token",
  display: {
    name: "AtomCode",
    icon: "smart_toy",
    color: "#2F6BFF",
    textIcon: "AC",
    website: "https://atomgit.com",
    notice: {
      signupUrl: "https://atomgit.com",
    },
  },
  transport: {
    baseUrl: `${ATOMCODE_DEFAULT_GATEWAY_BASE}/chat/completions`,
    format: "openai",
    headers: {
      // Functional: claiming to be `atomcode/<version>` arms the signature gate.
      "User-Agent": ATOMCODE_ADAPTER_USER_AGENT,
    },
    timeoutMs: ATOMCODE_CHAT_TIMEOUT_MS,
    stallTimeoutMs: ATOMCODE_CHAT_TIMEOUT_MS,
    usage: {
      url: `${CODINGPLAN}${ATOMCODE_CODINGPLAN_STATUS_PATH}`,
    },
  },
  oauth: {
    brokerBaseUrl: BROKER,
    loginUrl: `${BROKER}${ATOMCODE_BROKER_LOGIN_PATH}?provider=atomgit`,
    checkUrl: `${BROKER}${ATOMCODE_BROKER_CHECK_PATH}`,
    tokenUrl: `${BROKER}${ATOMCODE_BROKER_TOKEN_PATH}`,
    refreshUrl: `${BROKER}${ATOMCODE_BROKER_REFRESH_PATH}`,
    // Refresh rotates the refresh token; refresh an hour early rather than
    // spend a dead token on a chat request.
    refreshLeadMs: 3_600_000,
  },
  models: ATOMCODE_MODELS,
  features: {
    usage: true,
    // API-key connections are the same OAuth bearer; status-v2 reads them too.
    usageApikey: true,
  },
};
