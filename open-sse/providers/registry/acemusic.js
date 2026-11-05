// ACE Music（acemusic.ai）— ACE-Step 开源音乐生成模型的托管端点。
// 官方称"全球首个开源 Music AI 平台"（跃阶星辰 ACE-Step 系）。
//
// 协议（2026-11-05 实测）：标准 OpenAI Chat Completions——
//   base https://api.acemusic.ai/v1，Bearer API-Key（acemusic.ai 控制台 Api Key 页），
//   /v1/models 与 /v1/chat/completions 全套可用；错误体同 OpenAI（auth_error 等）。
//   另接受 query 参数 ai_token=<key>（等价 Bearer），我们只走标准头。
//
// 响应形态（音乐输出走 OpenAI audio 方言）：
//   - 非流式 message.content = 歌词/元数据 markdown；message.audio[] =
//     [{type:"audio_url", audio_url:{url:"data:audio/mpeg;base64,…"}}]（整曲 base64 MP3）；
//   - 流式 delta.audio[] 同形状、**整曲单帧**（~600KB/帧），无 usage 块（finish 帧不带，
//     网关按文本长度估算）。因此 hasValuableContent / combo 判定 / empty-retry 门禁
//     都必须把 delta.audio/message.audio 计为有效内容，否则音乐会整帧被剥。
//   - usage 口径：completion_tokens=100（上游把一首歌按固定 100 token 计），prompt=0。
//
// 归类：serviceKinds 只有 "music"（无 "llm"）——生成音乐是媒体创作，与 tts/image 同
// 列「媒体提供商 → 音乐」；网关侧配套 POST /v1/audio/music（src/sse/handlers/music.js，
// 内部走 chat 管线后抽取 message.audio）。上游模型 id 自带 acemusic/ 命名空间，与
// provider id 同名——registry 存裸 id + upstreamModelId 映射，避免客户端看到
// acemusic/acemusic/... 双前缀（resolver 剥掉与 provider 同名前缀后按裸 id 查行，
// 见 capabilities PROVIDER_CAPABILITIES.acemusic 注释）。
// Claude/Gemini 格式客户端仅能得到歌词文本（audio 数组在响应翻译器中无映射）——
// 生歌请走 /v1/audio/music 或 OpenAI 格式 /v1/chat/completions。
export default {
  id: "acemusic",
  priority: 69,
  alias: "acemusic",
  serviceKinds: ["music"],
  display: {
    name: "ACE Music",
    icon: "music_note",
    color: "#7C3AED",
    textIcon: "AM",
    website: "https://acemusic.ai",
    notice: {
      apiKeyUrl: "https://acemusic.ai",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.acemusic.ai/v1/chat/completions",
    validateUrl: "https://api.acemusic.ai/v1/models",
  },
  models: [
    // kind: "music" — ModelsCard/示例卡按 getModelKind 过滤媒体模型；缺这个标记
    // 「模型 — MUSIC」区和示例卡模型下拉都是空的（用户实测 2026-11-05）。
    { id: "acestep-v1.5-turbo", name: "ACE-Step", kind: "music", upstreamModelId: "acemusic/acestep-v1.5-turbo" },
  ],
};
