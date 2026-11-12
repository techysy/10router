// Gemini Decision 1 — Google DeepMind's decision model (2026-11-11, issue #110).
// Rides the System One decision lane next to Drex: typed questions
// (noul / choice / score) in, calibrated probability distributions out.
//
// Drex 协议同构但三处不同（issue #110 实测验证 2026-11-12）：
//   1. 鉴权 x-goog-api-key header（不是 Bearer）— systemoneConfig.authHeader
//   2. 输入字段 input（string 或 Content[]），不是 state — systemoneCore 规范化
//   3. 端点 /v1beta/decisions，普通 generateContent 调不通（独立透传 lane）
//
// 原生支持文本/图片/音频/视频/PDF 五模态（Drex 只有文本/图片），补齐多模态
// 决策空档；Agent 侧可按模态路由：文本/图片走 Drex，音/视频/PDF 走 Gemini。
//
// API Key 从 Google AI Studio 创建（非 Antigravity OAuth 路径）。
// 免费层 200 req/min + 50K input tokens/min（免费层内容会被 Google 用于产品
// 改进 — UI 提示走 display.notice）。
//
// 定价 $0.10/M input，输出 0 token 不计费；上下文 262,144 tokens。
// 题型语义细节（noul 0.01–0.99、choice 字母序平局、score 0 基索引）见
// issue #110 —— 透传层不加工，上游语义原样呈现给调用方。
export default {
  id: "gemini-decision",
  alias: "gmd",
  category: "apikey",
  display: {
    name: "Gemini Decision",
    icon: "psychology",
    color: "#1A73E8",
    textIcon: "GD",
    website: "https://aistudio.google.com/docs/models/gemini-decision-1",
    notice: {
      apiKeyUrl: "https://aistudio.google.com/apikey",
      // 免费层数据使用提示 — issue #110 明确要求 UI 告知。
      text: "FREE_TIER_DATA_NOTICE",
    },
  },
  models: [
    { id: "gemini-decision-1", name: "Gemini Decision 1", kind: "systemone" },
  ],
  serviceKinds: ["systemone"],
  systemoneConfig: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/decisions",
    authType: "apikey",
    authHeader: "x-goog-api-key",
  },
};
