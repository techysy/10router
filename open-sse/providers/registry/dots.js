// Dots (小红书 Dots Studio) — free-beta OpenAI-compatible gateway.
// Docs: https://dots.ai/platform/docs
// Auth uses a CUSTOM "api-key" header (NOT Bearer) — handled via
// transport.auth { header: "api-key", scheme: "raw" } in executors/default.js.
// NOTE: host is a beta endpoint (note3-prev-...) and may change on GA.
// Thinking is controlled via chat_template_kwargs.enable_thinking (on by default).
export default {
  id: "dots",
  alias: "dots",
  display: {
    name: "Dots",
    icon: "hub",
    color: "#FF2442",
    textIcon: "DT",
    website: "https://dots.ai",
    notice: {
      apiKeyUrl: "https://dots.ai/platform/apikeys",
    },
  },
  // Free public beta (公测) — grouped with the free-tier providers in the UI;
  // flip back to "apikey" when Dots starts charging.
  // 2026-11-18 官方文档已挂定价表(dots3-note-prev USD/1M:输入 $0.14/输出
  // $0.28),但明示「当前免费体验，暂不收费，恢复收费前将通过官网及 API 页面
  // 提前告知」——实际计费仍为 0,pricing.js 按 0 记;收费落地时改价并去掉
  // freeTrial 旗标(仪表盘卡片的绿色「免费」徽章随之消失)。
  category: "freeTier",
  freeTrial: true,
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://note3-prev-api.askdiandian.com/v1/chat/completions",
    auth: { combined: true, header: "api-key", scheme: "raw" },
    // No documented GET /models endpoint — connection validation falls back to a chat ping.
  },
  models: [{ id: "dots3-note-prev", name: "Dots3 Note Prev" }],
};
