import { handleTts } from "@/sse/handlers/tts.js";

export async function OPTIONS() {
  const raw=(process.env.CORS_ALLOW_ORIGINS||"").split(",").map(s=>s.trim()).filter(Boolean);
  const allowOrigin=process.env.NODE_ENV==="development"||raw.includes("*")?"*":(raw[0]||"*");
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/audio/speech - OpenAI-compatible TTS endpoint */
export async function POST(request) {
  return await handleTts(request);
}
