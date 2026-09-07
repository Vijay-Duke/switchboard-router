import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  transformRequest(model, body, stream, credentials) {
    super.transformRequest(model, body, stream, credentials);
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    return MESSAGES_MODELS.has(model)
      ? `${base}/zen/v1/messages`
      : `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "x-opencode-client": "desktop",
    };
    // zen free tier 400s MissingSessionID ("free tier can only be used in
    // OpenCode") without a stable session header — same contract the
    // DefaultExecutor enforces for opencode.ai hosts. All our URLs are
    // opencode.ai, so no hostname check needed here.
    if (!headers["x-opencode-session"]) {
      headers["x-opencode-session"] = resolveSessionId({
        headers: credentials?.rawHeaders,
        connectionId: credentials?.connectionId,
        scope: "opencode",
      });
    }
    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }
}
