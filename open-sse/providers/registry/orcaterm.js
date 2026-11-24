import { ORCATERM_CONFIG, ORCATERM_MODELS } from "../../config/orcaterm.js";

export default {
  id: "orcaterm",
  alias: "orcaterm",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  display: {
    name: "OrcaTerm",
    icon: "terminal",
    color: "#0088CC",
    textIcon: "OT",
    website: ORCATERM_CONFIG.origin,
    notice: { signupUrl: ORCATERM_CONFIG.origin },
  },
  transport: {
    baseUrl: ORCATERM_CONFIG.chatUrl,
    format: "openai",
    headers: {
      "X-Product": ORCATERM_CONFIG.product,
      Origin: ORCATERM_CONFIG.origin,
      Referer: `${ORCATERM_CONFIG.origin}/terminal`,
      "X-Referer": `${ORCATERM_CONFIG.origin}/terminal`,
    },
  },
  oauth: {
    authorizeUrl: ORCATERM_CONFIG.wechatConfigUrl,
    tokenUrl: ORCATERM_CONFIG.exchangeUrl,
    refreshUrl: ORCATERM_CONFIG.refreshUrl,
    refreshLeadMs: 10 * 60 * 1000,
  },
  models: ORCATERM_MODELS.map(({ id, name }) => ({ id, name })),
};
