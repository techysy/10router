// THX-01 — HAL-X's typed decision model. Rides the /v1/systemone decision lane
// with zero chat translation: state + typed questions (choice / noul / score /
// number / excerpt / cite) in, calibrated answers out. Bearer auth with an
// sk- key, injected by the systemoneCore handler. The API exposes no quota
// endpoint, so no usage card is wired (features.usage stays unset).
export default {
  id: "thx",
  alias: "thx",
  aliases: ["hal-x", "halx"],
  category: "apikey",
  display: {
    name: "THX-01 (HAL-X)",
    icon: "psychology",
    color: "#0EA5E9",
    textIcon: "TX",
    website: "https://api.hal-x.ai",
    notice: {
      text: "THX-01 decision model: calibrated answers to typed questions in ~10 ms per request.",
      apiKeyUrl: "https://api.hal-x.ai",
    },
  },
  models: [{ id: "thx-01", name: "THX-01", kind: "systemone" }],
  serviceKinds: ["systemone"],
  systemoneConfig: {
    baseUrl: "https://api.hal-x.ai/v1/systemone",
  },
};
