// StepFun 阶跃星辰开放平台 · 国际站（api.stepfun.ai）。按量计费渠道：扣账户现金
// / 赠送代金券（GET /v1/accounts 可查）。中国站同构命名为 stepfun-cn；走订阅套餐
// Credit 的是 stepfun-plan（/step_plan/v1）。
//
// dual-protocol（OpenAI Chat Completions + 原生 Anthropic Messages，docs 2026-09）：
// base https://api.stepfun.ai/v1，Bearer API key 取自 platform.stepfun.ai/interface-key。
//
// 图像生成已下架（2026-09-21）：官方公告（docs/en/guides/image-offline-notice）宣布
// step-2x-large / step-image-edit-2 与 /v1/images/{generations,image2image,edits} 于
// 2026-10-10 在国内外同步停服（step-1x-edit 更早已不可调用），而实测该服务在下线前
// 就已持续返回 503。故本渠道不再暴露图像能力：移除两个 kind:"image" 模型、imageConfig
// 与 serviceKinds 中的 "image"，媒体提供商「文本转图像」不再出现 StepFun 卡片。
//
// step-router-v1 故意不在本渠道：它只在 Step Plan 渠道提供。
//
// 模型按 kind 严格分区：
//   - LLM（chat/vision）：step-5-preview, step-3.7-flash, step-3.5-flash(-2603), step-1o-turbo-vision
//   - TTS：stepaudio-3-tts, stepaudio-2.5-tts, step-tts-2, step-tts-mini（kind: "tts"，归 media-providers/tts）
//   - STT：stepaudio-2.5-asr（kind: "stt"，归 media-providers/stt）
//
// 对话式音频模型（stepaudio-2.5-chat、step-audio-2 等）与 realtime WebSocket 端点
// 均不入库，避免污染纯 LLM 选择器。
export default {
  id: "stepfun",
  priority: 67,
  alias: "step",
  aliases: ["stepfun", "sf"],
  display: {
    name: "StepFun",
    icon: "bolt",
    color: "#2E5BFF",
    textIcon: "SF",
    website: "https://platform.stepfun.ai",
    notice: {
      apiKeyUrl: "https://platform.stepfun.ai/interface-key",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.stepfun.ai/v1/chat/completions",
    validateUrl: "https://api.stepfun.ai/v1/models",
  },
  models: [
    { id: "step-5-preview", name: "Step 5 Preview" },
    { id: "step-3.7-flash", name: "Step 3.7 Flash" },
    { id: "step-3.5-flash", name: "Step 3.5 Flash" },
    { id: "step-3.5-flash-2603", name: "Step 3.5 Flash 2603" },
    { id: "step-1o-turbo-vision", name: "Step-1o Turbo Vision" },
    { id: "stepaudio-3-tts", name: "StepAudio 3 TTS", kind: "tts" },
    { id: "stepaudio-2.5-tts", name: "StepAudio 2.5 TTS", kind: "tts" },
    { id: "step-tts-2", name: "Step TTS 2", kind: "tts" },
    { id: "step-tts-mini", name: "Step TTS Mini", kind: "tts" },
    { id: "stepaudio-2.5-asr", name: "StepAudio 2.5 ASR", kind: "stt" },
    // 音乐生成（官方 docs models/stepaudio-3-music，2026-11-05）：异步任务式
    // （submit + query 轮询），不走 chat completions —— 见 musicConfig。
    // `stepaudio-3-music-preview` 是限免期模型名，到期后官方会下线预览版并上新
    // 正式付费版（届时改 id + 定价）。
    { id: "stepaudio-3-music-preview", name: "StepAudio 3 Music", kind: "music" },
  ],
  serviceKinds: ["llm", "imageToText", "tts", "stt", "music"],
  features: {
    usage: true,
    usageApikey: true,
  },
  // OpenAI-compatible TTS. Voice is required upstream; clients encode it in the
  // model string ("stepaudio-2.5-tts/cixingnansheng"), defaultVoice covers a bare
  // id. 磁性男声 is the voice used throughout the official examples.
  ttsConfig: {
    baseUrl: "https://api.stepfun.ai/v1/audio/speech",
    authType: "apikey",
    authHeader: "bearer",
    format: "openai",
    defaultVoice: "cixingnansheng",
  },
  // Multipart Whisper-compatible transcription (model + file + response_format).
  sttConfig: {
    baseUrl: "https://api.stepfun.ai/v1/audio/transcriptions",
    authType: "apikey",
    authHeader: "bearer",
    format: "openai",
  },
  // 原生音乐生成 API（docs api-reference/audio/music，2026-11-05）：HTTP 异步
  // 「提交 + 查询」——/submit 返回 task_id，/query 每 5 秒轮询到 SUCCESS/FAILED
  // 终态，SUCCESS 带 base64 音频。网关 /v1/audio/music 按 musicConfig.mode 分派：
  // 这里是原生异步，acemusic 走 chat-completions 模式。caption 必填（曲风描述），
  // lyrics 可选（不传由服务端自动写词）。
  musicConfig: {
    mode: "stepfun-async",
    submitUrl: "https://api.stepfun.ai/v1/audio/music/submit",
    queryUrl: "https://api.stepfun.ai/v1/audio/music/query",
    authType: "apikey",
    authHeader: "bearer",
    modelIdUpstream: "stepaudio-3-music-preview",
    defaultResponseFormat: "mp3",
  },
};
