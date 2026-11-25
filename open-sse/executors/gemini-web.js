import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", PROVIDERS["gemini-web"]);
  }

  async generateMedia({ prompt, size, n = 1, credentials, log }) {
    if (!prompt?.trim()) throw new Error("prompt is required for image generation");
    const cookie = credentials?.apiKey || credentials?.accessToken || "";
    if (!cookie) {
      throw new Error("Gemini Web requires your __Secure-1PSID cookie configured in connection");
    }

    throw new Error("Gemini Web image generation requires an active browser session with Gemini Web credentials");
  }

  async execute() {
    throw new Error("Gemini Web is currently in image-only preview mode");
  }
}

export default GeminiWebExecutor;
