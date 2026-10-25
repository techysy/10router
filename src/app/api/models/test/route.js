import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";
import { resolveRequestLocale, serverTranslate } from "@/i18n/serverTranslate.js";

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const result = await pingModelByKind(model, kind || "llm");
    // Model-ping errors reach the dashboard verbatim in the model cards — same
    // server-side dictionary as the per-provider test routes (pattern layer
    // rewrites unwrapped upstream sentences in place). Unknown strings pass through.
    if (result?.error) result.error = serverTranslate(resolveRequestLocale(request), result.error);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
