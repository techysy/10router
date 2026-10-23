import { NextResponse } from "next/server";
import { testSingleConnection } from "./testUtils.js";
import { resolveRequestLocale, serverTranslate } from "@/i18n/serverTranslate.js";

// POST /api/providers/[id]/test - Test connection with optional model selection
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    // Body is optional: the one-by-one loop and the edit-connection modal POST
    // with no body at all (the pre-model-selection callers). An unguarded
    // request.json() threw on the empty body and every one-by-one test came
    // back as a 500 "Test failed".
    const body = await request.json().catch(() => ({}));
    const result = await testSingleConnection(id, { model: body.model || null });

    // Test errors AND soft warnings reach the user verbatim in the row/chip, so
    // they go through the same server-side dictionary as the 429 path — the
    // client i18n runtime never sees these strings. Unknown strings pass through.
    const locale = resolveRequestLocale(request);
    let localizedError = result.error ? serverTranslate(locale, result.error) : result.error;
    // Soft warnings ride the same field on success (testSingleConnection keeps
    // warning text in result.error for the dashboard chip) — translate both.
    if (result.warning) localizedError = serverTranslate(locale, result.warning);

    // The not-granted skeleton is translated as a whole; the model name rides
    // after it so the dictionary never needs interpolation support.
    const model = body.model || null;
    if (model && localizedError === serverTranslate(locale, "Model not available on this account (Google preview/rollout not granted)")) {
      localizedError = `${localizedError}: ${model}`;
    }

    if (result.error === "Connection not found") {
      return NextResponse.json({ error: localizedError }, { status: 404 });
    }

    return NextResponse.json({
      valid: result.valid,
      error: localizedError,
      refreshed: result.refreshed || false,
    });
  } catch (error) {
    console.log("Error testing connection:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
