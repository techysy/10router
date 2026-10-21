/**
 * Usage Fetcher - Get usage data from provider APIs
 */

import { getGitHubUsage } from "./usage/github.js";
import { getGeminiUsage, getAntigravityUsage } from "./usage/google.js";
import { getClaudeUsage, consumeClaudeResetGrant } from "./usage/claude.js";
import { getCodexUsage, consumeCodexRateLimitResetCredit, getCodexRateLimitResetCredits } from "./usage/codex.js";

export { consumeCodexRateLimitResetCredit, getCodexRateLimitResetCredits, consumeClaudeResetGrant };
import { getKiroUsage } from "./usage/kiro.js";
import { getMiniMaxUsage } from "./usage/minimax.js";
import { getCodeBuddyCnUsage, getCodeBuddyIntlUsage } from "./usage/codebuddy-cn.js";
import { getGrokCliUsage } from "./usage/grok-cli.js";
import { getKimiUsage } from "./usage/kimi.js";
import { getDeepseekUsage } from "./usage/deepseek.js";
import { getOpencodeGoUsage } from "./usage/opencode-go.js";
import { getOpenCodeZenUsage } from "./usage/opencode-zen.js";
import { getXiaomiMimoUsage, getXiaomiTokenPlanUsage } from "./usage/xiaomi-mimo.js";
import { getStepfunUsage, STEPFUN_ACCOUNTS_HOSTS } from "./usage/stepfun.js";
import { resolveQoderCredentials } from "./qoderModels.js";
import {
  getIflowUsage,
  getOllamaUsage,
  getVercelAiGatewayUsage,
  getQoderUsage,
  getAlibabaTokenPlanUsage,
} from "./usage/misc.js";
import { getGlmUsage } from "./usage/glm.js";
import { getCommandCodeUsage } from "./usage/commandcode.js";
import { getMiniMaxCodeUsage } from "./usage/minimax-code.js";
import { getLobsterAiUsage } from "./usage/lobsterai.js";
import { getRaccoonUsage } from "./usage/raccoon.js";
import { getAtomcodeUsage } from "./usage/atomcode.js";
import { getLoomyUsage } from "./usage/loomy.js";
import { getOfficeAceUsage } from "./usage/officeace.js";
import { getCodeArtsUsage } from "./usage/codearts.js";
import { getCursorUsage } from "./usage/cursor.js";
import { extractEarliestPackageExpiry } from "./usage/expiryExtractor.js";

/**
 * Get usage data for a provider connection
 * @param {Object} connection - Provider connection with accessToken
 * @returns {Object} Usage data with quotas
 */
// provider → usage handler (ctx carries every arg each handler needs)
const USAGE_HANDLERS = {
  github: (c) => getGitHubUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  "gemini-cli": (c) => getGeminiUsage(c.accessToken, c.providerDataWithProjectId, c.proxyOptions),
  antigravity: (c) => getAntigravityUsage(c.accessToken, c.providerSpecificData, c.proxyOptions, { force: c.force }),
  claude: (c) => getClaudeUsage(c.accessToken, c.proxyOptions, { force: c.force }),
  codex: (c) => getCodexUsage(c.accessToken, c.proxyOptions),
  kiro: (c) => getKiroUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  qoder: async (c) => {
    // PAT (pt-...) connections must be exchanged to a job token before the
    // quota endpoint accepts them.
    const resolved = await resolveQoderCredentials(c, c.proxyOptions).catch(() => null);
    return getQoderUsage(resolved?.accessToken || c.accessToken, c.proxyOptions, "qoder", c.providerSpecificData);
  },
  "qoder-cn": async (c) => {
    const resolved = await resolveQoderCredentials(c, c.proxyOptions).catch(() => null);
    return getQoderUsage(resolved?.accessToken || c.accessToken, c.proxyOptions, "qoder-cn", c.providerSpecificData);
  },
  iflow: (c) => getIflowUsage(c.accessToken),
  ollama: (c) => getOllamaUsage(c.apiKey, c.providerSpecificData, c.proxyOptions),
  // GLM 双认证：粘贴 apikey 或 OAuth 登录（coding-plan key 存在 accessToken 上）
  glm: (c) => getGlmUsage(c.apiKey || c.accessToken, c.provider, c.proxyOptions),
  "glm-cn": (c) => getGlmUsage(c.apiKey || c.accessToken, c.provider, c.proxyOptions),
  minimax: (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "minimax-cn": (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "vercel-ai-gateway": (c) => getVercelAiGatewayUsage(c.apiKey, c.proxyOptions),
  "codebuddy-cn": (c) => getCodeBuddyCnUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
  "codebuddy-intl": (c) => getCodeBuddyIntlUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
  "grok-cli": (c) => getGrokCliUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  kimi: (c) => getKimiUsage(c.accessToken, c.apiKey, c.proxyOptions, c.providerSpecificData),
  deepseek: (c) => getDeepseekUsage(c.apiKey, c.proxyOptions),
  "opencode-go": (c) => getOpencodeGoUsage(c.apiKey, c.proxyOptions),
  "opencode-zen": (c) => getOpenCodeZenUsage(c.apiKey, c.proxyOptions),
  // The cloud card bills through the plan / API at formal rates and owns NO
  // Desktop surface, so it reports no quota at all: no session read (that is how
  // it advertised a "Desktop session" it never had) and no key probe (whose 401
  // fallback printed a weekly-quota notice it also does not own). The handler
  // short-circuits to an empty result on this flag.
  "xiaomi-mimo": (c) =>
    getXiaomiMimoUsage(c.accessToken, c.providerSpecificData, c.proxyOptions, { allowMachineSession: false }),
  // The Desktop card, split out of xiaomi-mimo. It reads the SAME weekly allowance
  // through the account session — and its connection is the one that actually
  // carries mimoPassToken. Without this entry the card fell through to "Usage API
  // not implemented for mimo-desktop" and showed no quota at all, while the cloud
  // card showed one. Missed when the three-card split added the id.
  // Machine-session fallback stays enabled: a Desktop row with no stored passToken
  // reads the running Desktop's own cookie store, exactly like the executor does.
  "mimo-desktop": (c) => getXiaomiMimoUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  // Token Plan keys (tp-) live on a cluster with no quota endpoint at all — the
  // handler exists so the row can explain that instead of falling through to
  // "Usage API not implemented for xiaomi-tokenplan".
  "xiaomi-tokenplan": (c) => getXiaomiTokenPlanUsage(c.apiKey, c.providerSpecificData, c.proxyOptions),
  stepfun: (c) => getStepfunUsage(c.apiKey, c.proxyOptions, STEPFUN_ACCOUNTS_HOSTS.stepfun),
  "stepfun-cn": (c) => getStepfunUsage(c.apiKey, c.proxyOptions, STEPFUN_ACCOUNTS_HOSTS["stepfun-cn"]),
  commandcode: (c) => getCommandCodeUsage(c.apiKey, c.proxyOptions),
  "minimax-code": (c) => getMiniMaxCodeUsage(c.accessToken, "minimax-code", c.proxyOptions, c.providerSpecificData),
  "minimax-code-global": (c) => getMiniMaxCodeUsage(c.accessToken, "minimax-code-global", c.proxyOptions, c.providerSpecificData),
  lobsterai: (c) => getLobsterAiUsage(c.accessToken, c.proxyOptions),
  // Bearer JWT is stored on apiKey for an apikey-category connection; OAuth-like
  // imports may carry it on accessToken instead. Accept both.
  raccoon: (c) => getRaccoonUsage(c.accessToken || c.apiKey, c.proxyOptions),
  atomcode: (c) => getAtomcodeUsage(c.accessToken, c.apiKey, c.proxyOptions),
  // Loomy session 可能被贴在 apiKey（手工导入）或 accessToken（会话导入）上。
  loomy: (c) => getLoomyUsage(c.accessToken || c.apiKey, c.proxyOptions),
  // 控制面（/v1/subscription）要 V11 签名：apiKey 是网关 Basic 对，AK/SK/STS
  // 在 providerSpecificData 里；缺了就返回一条可执行的说明。
  officeace: (c) => getOfficeAceUsage(c.apiKey, c.providerSpecificData, c.proxyOptions),
  codearts: (c) => getCodeArtsUsage({ ...(c.providerSpecificData || {}), ...c }, c.proxyOptions),
  // Alibaba Token Plan（credit 订阅 key）：没有任何公开额度接口，handler 只返回
  // 一条指向百炼控制台的说明，避免漏成 "Usage API not implemented"（见 misc.js）。
  "alitp-intl": (c) => getAlibabaTokenPlanUsage("alitp-intl"),
  "alitp-cn": (c) => getAlibabaTokenPlanUsage("alitp-cn"),
  cursor: (c) => getCursorUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
};

export async function getUsageForProvider(connection, proxyOptions = null, options = {}) {
  const { provider, accessToken, apiKey, providerSpecificData, projectId } = connection;
  const providerDataWithProjectId = {
    ...(providerSpecificData || {}),
    ...(projectId ? { projectId } : {}),
  };

  const handler = USAGE_HANDLERS[provider];
  if (!handler) return { message: `Usage API not implemented for ${provider}` };
  return await handler({
    provider,
    accessToken,
    apiKey,
    providerSpecificData,
    providerDataWithProjectId,
    proxyOptions,
    force: options.force === true,
  });
}

export { extractEarliestPackageExpiry };
