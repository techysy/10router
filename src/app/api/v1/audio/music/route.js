import { handleMusic } from "@/sse/handlers/music.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/audio/music - music generation endpoint (media kind "music") */
export async function POST(request) {
  return await handleMusic(request);
}
