export default {
  id: "dumate",
  priority: 185,
  alias: "dumate",
  aliases: ["du"],
  uiAlias: "dumate",
  display: {
    name: "DuMate 百度搭子 (Web)",
    icon: "cookie",
    color: "#2932E1",
    textIcon: "DU",
    website: "https://cloud.baidu.com/product/dumate.html",
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["llm"],
  authHint:
    "QR login is recommended (see the provider page). Or paste the Baidu cookies of a logged-in DuMate session " +
    "(console.bce.baidu.com): a full Cookie header string or an exported cookies JSON. 10Router exchanges them " +
    "for the DuMate gateway token and renews it automatically; while the Baidu passport cookies (BDUSS) are " +
    "alive the console session is silently re-established. When the login itself dies the connection is " +
    "marked needs-reauth.",
  transport: {
    baseUrl: "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions",
    format: "openai",
    authType: "cookie",
  },
  models: [
    { id: "deepseek-v41-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
    { id: "kimi-k31", name: "Kimi K3.1" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "glm-53", name: "GLM-5.3" },
    { id: "glm-53-flash", name: "GLM-5.3 Flash" },
    { id: "model-text", name: "DuMate model-text" },
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "qwen38-flash", name: "Qwen3.8 Flash" },
    { id: "qwen3.5-397b-a17b", name: "Qwen3.5 397B A17B" },
    { id: "qwen3.5-35b-a3b", name: "Qwen3.5 35B A3B" },
    { id: "qwen3.5-27b", name: "Qwen3.5 27B" },
    { id: "doubao-seed-2-0-pro", name: "Doubao Seed 2.0 Pro" },
    { id: "dm-auto-model/text.L2", name: "DuMate Auto L2" },
    { id: "dm-auto-model/text.L1", name: "DuMate Auto L1" },
    { id: "dm-auto-model/text.L0", name: "DuMate Auto L0" },
    { id: "ernie-4.5-turbo-vl-32k", name: "ERNIE 4.5 Turbo VL 32K" },
    { id: "qwen2.5-vl-32b-instruct", name: "Qwen2.5 VL 32B Instruct" },
  ],
  passthroughModels: true,
};
