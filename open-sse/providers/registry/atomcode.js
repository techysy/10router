import { ATOMCODE_CONFIG, ATOMCODE_MODELS } from "../../config/atomcode.js";

export default {
  id: "atomcode",
  alias: "atomcode",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  hasFree: true,
  display: {
    name: "AtomCode",
    icon: "code",
    color: "#E5352D",
    textIcon: "AC",
    website: ATOMCODE_CONFIG.website,
    notice: { signupUrl: ATOMCODE_CONFIG.website },
  },
  transport: {
    baseUrl: `${ATOMCODE_CONFIG.llmBaseUrl}/chat/completions`,
    format: "openai",
    thinkingFormat: "openai",
    headers: { "User-Agent": ATOMCODE_CONFIG.userAgent },
  },
  oauth: {
    ...ATOMCODE_CONFIG,
    refreshLeadMs: 12 * 60 * 60 * 1000,
  },
  models: ATOMCODE_MODELS.map(({ id, name }) => ({ id, name })),
};
