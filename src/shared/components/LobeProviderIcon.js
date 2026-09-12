"use client";

/**
 * Lobe provider icons (@lobehub/icons) — official brand SVGs for the subset of
 * our provider ids Lobe covers. Deep per-icon imports keep the bundle to only
 * the icons we use (the main entry re-exports 300+ icons and must not be
 * pulled in whole). Ids NOT in this map (Chinese gateways, self-hosted, local
 * etc.) render the hand-curated `/providers/{id}.png` via the normal
 * ProviderIcon fallback path.
 *
 * Map keys = our registry ids; values = the exact PascalCase icon dir under
 * node_modules/@lobehub/icons/es/ (verified against the installed version).
 * Rendering prefers the icon's Color variant when it exists (runtime guard —
 * not every icon ships one) and falls back to the mono base.
 */

import OpenAI from "@lobehub/icons/es/OpenAI";
import Anthropic from "@lobehub/icons/es/Anthropic";
import Claude from "@lobehub/icons/es/Claude";
import Gemini from "@lobehub/icons/es/Gemini";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import Minimax from "@lobehub/icons/es/Minimax";
import Groq from "@lobehub/icons/es/Groq";
import Nvidia from "@lobehub/icons/es/Nvidia";
import XAI from "@lobehub/icons/es/XAI";
import OpenRouter from "@lobehub/icons/es/OpenRouter";
import Mistral from "@lobehub/icons/es/Mistral";
import Cohere from "@lobehub/icons/es/Cohere";
import Perplexity from "@lobehub/icons/es/Perplexity";
import Together from "@lobehub/icons/es/Together";
import Fireworks from "@lobehub/icons/es/Fireworks";
import SiliconCloud from "@lobehub/icons/es/SiliconCloud";
import Moonshot from "@lobehub/icons/es/Moonshot";
import Zhipu from "@lobehub/icons/es/Zhipu";
import Aws from "@lobehub/icons/es/Aws";
import Azure from "@lobehub/icons/es/Azure";
import Cloudflare from "@lobehub/icons/es/Cloudflare";
import HuggingFace from "@lobehub/icons/es/HuggingFace";
import Ollama from "@lobehub/icons/es/Ollama";
import SambaNova from "@lobehub/icons/es/SambaNova";
import Cerebras from "@lobehub/icons/es/Cerebras";
import Venice from "@lobehub/icons/es/Venice";
import Nebius from "@lobehub/icons/es/Nebius";
import Hyperbolic from "@lobehub/icons/es/Hyperbolic";
import Featherless from "@lobehub/icons/es/Featherless";
import Baidu from "@lobehub/icons/es/Baidu";
import Tencent from "@lobehub/icons/es/Tencent";
import Doubao from "@lobehub/icons/es/Doubao";
import Github from "@lobehub/icons/es/Github";
import Gitlab from "@lobehub/icons/es/Gitlab";
import Cursor from "@lobehub/icons/es/Cursor";
import Cline from "@lobehub/icons/es/Cline";
import Windsurf from "@lobehub/icons/es/Windsurf";
import Zed from "@lobehub/icons/es/Zed";
import Kiro from "@lobehub/icons/es/Kiro";
import Trae from "@lobehub/icons/es/Trae";
import Jina from "@lobehub/icons/es/Jina";
import Exa from "@lobehub/icons/es/Exa";
import Tavily from "@lobehub/icons/es/Tavily";
import Brave from "@lobehub/icons/es/Brave";
import SearchApi from "@lobehub/icons/es/SearchApi";
import SearXNG from "@lobehub/icons/es/SearXNG";
import FishAudio from "@lobehub/icons/es/FishAudio";
import AssemblyAI from "@lobehub/icons/es/AssemblyAI";
import ElevenLabs from "@lobehub/icons/es/ElevenLabs";
import Voyage from "@lobehub/icons/es/Voyage";
import Fal from "@lobehub/icons/es/Fal";
import Recraft from "@lobehub/icons/es/Recraft";
import Stability from "@lobehub/icons/es/Stability";
import Runway from "@lobehub/icons/es/Runway";
import Morph from "@lobehub/icons/es/Morph";
import ComfyUI from "@lobehub/icons/es/ComfyUI";
import SenseNova from "@lobehub/icons/es/SenseNova";
import LongCat from "@lobehub/icons/es/LongCat";
import VertexAI from "@lobehub/icons/es/VertexAI";
import Vercel from "@lobehub/icons/es/Vercel";

export const LOBE_PROVIDER_ICONS = {
  openai: OpenAI,
  anthropic: Anthropic,
  claude: Claude,
  gemini: Gemini,
  deepseek: DeepSeek,
  minimax: Minimax,
  "minimax-cn": Minimax,
  groq: Groq,
  nvidia: Nvidia,
  xai: XAI,
  openrouter: OpenRouter,
  mistral: Mistral,
  cohere: Cohere,
  perplexity: Perplexity,
  together: Together,
  fireworks: Fireworks,
  siliconflow: SiliconCloud,
  kimi: Moonshot,
  glm: Zhipu,
  "glm-cn": Zhipu,
  "aws-polly": Aws,
  azure: Azure,
  "cloudflare-ai": Cloudflare,
  huggingface: HuggingFace,
  ollama: Ollama,
  sambanova: SambaNova,
  cerebras: Cerebras,
  venice: Venice,
  nebius: Nebius,
  hyperbolic: Hyperbolic,
  featherless: Featherless,
  baidu: Baidu,
  tencent: Tencent,
  "volcengine-ark": Doubao,
  github: Github,
  gitlab: Gitlab,
  cursor: Cursor,
  cline: Cline,
  windsurf: Windsurf,
  zed: Zed,
  kiro: Kiro,
  trae: Trae,
  "jina-ai": Jina,
  exa: Exa,
  tavily: Tavily,
  "brave-search": Brave,
  searchapi: SearchApi,
  searxng: SearXNG,
  "fish-audio": FishAudio,
  assemblyai: AssemblyAI,
  elevenlabs: ElevenLabs,
  "voyage-ai": Voyage,
  "fal-ai": Fal,
  recraft: Recraft,
  "stability-ai": Stability,
  runwayml: Runway,
  morph: Morph,
  comfyui: ComfyUI,
  sensenova: SenseNova,
  longcat: LongCat,
  vertex: VertexAI,
  "vercel-ai-gateway": Vercel,
};

export default function LobeProviderIcon({ providerId, size = 32, className = "" }) {
  const Icon = LOBE_PROVIDER_ICONS[providerId];
  if (!Icon) return null;
  const Variant = Icon.Color || Icon;
  return <Variant size={size} className={className} />;
}
