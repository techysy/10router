import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export class ChatGptWebExecutor extends BaseExecutor {
  constructor() {
    super("chatgpt-web", PROVIDERS["chatgpt-web"]);
  }

  async generateMedia({ prompt, n = 1, size, credentials, signal, log }) {
    if (!prompt?.trim()) throw new Error("prompt is required for image generation");
    const cookie = credentials?.apiKey || credentials?.accessToken || "";
    if (!cookie) {
      throw new Error("ChatGPT Web requires your chatgpt.com cookie (__Secure-next-auth.session-token) configured in connection");
    }

    throw new Error("ChatGPT Web image generation requires a valid session token and active session");
  }

  async execute() {
    throw new Error("ChatGPT Web chat is currently in image-only preview mode");
  }
}

export default ChatGptWebExecutor;
