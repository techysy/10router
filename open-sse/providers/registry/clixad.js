import { CLIXAD_CONFIG, CLIXAD_MODELS } from "../../config/clixad.js";

export default {
  id: "clixad",
  alias: "clixad",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  hasFree: true,
  display: {
    name: "Clixad",
    icon: "terminal",
    color: "#F5B800",
    textIcon: "CX",
    website: CLIXAD_CONFIG.website,
    notice: { signupUrl: CLIXAD_CONFIG.website },
  },
  transport: {
    baseUrl: CLIXAD_CONFIG.chatUrl,
    format: "openai",
    thinkingFormat: "openai",
    headers: { "X-Clixad-Client": CLIXAD_CONFIG.clientHeader },
  },
  oauth: { ...CLIXAD_CONFIG },
  models: CLIXAD_MODELS.map(({ id, name }) => ({ id, name })),
};
