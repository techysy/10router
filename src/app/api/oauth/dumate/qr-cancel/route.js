import { getSession, pub, cancelSession } from "open-sse/shared/dumate/qr.js";
import { ownerOf, json } from "../lib.js";

/** POST /api/oauth/dumate/qr-cancel?sid=<sid> */
export async function POST(request) {
  try {
    const s = getSession(new URL(request.url).searchParams.get("sid"), ownerOf(request));
    if (!s) return json({ error: "QR session not found" }, 404);
    cancelSession(s);
    return json(pub(s));
  } catch (e) {
    return json({ error: String(e.message || e).slice(0, 200) }, 500);
  }
}
