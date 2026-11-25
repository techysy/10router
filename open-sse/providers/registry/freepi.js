import { FREEPI_CONFIG, FREEPI_MODELS } from "../../config/freepi.js";

export default {
  id: "freepi",
  alias: "freepi",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  hasFree: true,
  display: {
    name: "FreePi",
    icon: "terminal",
    color: "#7C3AED",
    textIcon: "FP",
    website: FREEPI_CONFIG.website,
    // Signing in accepts freepi.ai/terms (which bar proxy access) on the user's behalf.
    notice: { signupUrl: `${FREEPI_CONFIG.website}/terms` },
  },
  transport: {
    baseUrl: FREEPI_CONFIG.chatUrl,
    format: "openai",
    thinkingFormat: "openai",
    headers: {},
  },
  oauth: { ...FREEPI_CONFIG },
  models: FREEPI_MODELS.map(({ id, name }) => ({ id, name })),
};
