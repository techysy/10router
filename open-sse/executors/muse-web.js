import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";

export class MuseWebExecutor extends BaseExecutor {
  constructor() {
    super("muse-web", PROVIDERS["muse-web"]);
  }

  async generateMedia({ prompt, kind = "image", size, n = 1, credentials, log }) {
    if (!prompt?.trim()) throw new Error("prompt is required for media generation");
    const cookie = credentials?.apiKey || credentials?.accessToken || "";
    if (!cookie) {
      throw new Error("Muse Web requires your muse.ai session cookies configured in connection");
    }

    throw new Error("Muse Web generation requires active muse.ai Hatch credentials");
  }

  async execute() {
    throw new Error("Muse Web is currently in image/video preview mode");
  }
}

export default MuseWebExecutor;
