import { DefaultExecutor } from "./default.js";
import { CLIXAD_CONFIG } from "../config/clixad.js";

/**
 * ClixadExecutor — Clixad gateway (clixad.onrender.com/v1), plain
 * OpenAI chat/completions with the Clixad bearer. The gateway appends a
 * non-standard `clixad` billing block to the final frame; clients ignore
 * unknown keys, so it is passed through. Tokens never expire on a clock and
 * have no refresh: a 401 means the user signs in again.
 */
export class ClixadExecutor extends DefaultExecutor {
  constructor() {
    super("clixad");
  }

  buildHeaders(credentials, stream = true, url, model, transformedBody) {
    const headers = super.buildHeaders(credentials, stream, url, model, transformedBody);
    headers["X-Clixad-Client"] = CLIXAD_CONFIG.clientHeader;
    return headers;
  }

  async refreshCredentials() {
    return null;
  }
}

export default ClixadExecutor;
