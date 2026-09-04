import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { OAUTH_ENDPOINTS, GEMINI_CLI_API_CLIENT, geminiCLIUserAgent } from "../config/appConstants.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

function withoutTransportStream(body) {
  if (!body || typeof body !== "object") return body;
  const { stream: _stream, ...envelope } = body;
  if (!envelope.request || typeof envelope.request !== "object") return envelope;
  const { stream: _requestStream, ...request } = envelope.request;
  return { ...envelope, request };
}

/**
 * Convert a Google RPC RetryInfo.retryDelay Duration to milliseconds.
 * Accepts the JSON string form ("30s", "1.5s") and the object form
 * ({ seconds: "30", nanos: 0 }); returns null when unparseable.
 */
export function retryDelayToMs(value) {
  if (typeof value === "string") {
    const match = value.match(/^(\d+(?:\.\d+)?)s$/);
    if (!match) return null;
    const ms = Math.round(Number(match[1]) * 1000);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 1000) : null;
  }
  if (value && typeof value === "object") {
    const seconds = Number(value.seconds || 0);
    const nanos = Number(value.nanos || 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
    return Math.round(seconds * 1000 + nanos / 1e6);
  }
  return null;
}

export class GeminiCLIExecutor extends BaseExecutor {
  constructor() {
    super("gemini-cli", PROVIDERS["gemini-cli"]);
  }

  buildUrl(model, stream, urlIndex = 0) {
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${this.config.baseUrl}:${action}`;
  }

  buildHeaders(credentials, stream = true) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${credentials.accessToken}`,
      "User-Agent": geminiCLIUserAgent(this._currentModel),
      "X-Goog-Api-Client": GEMINI_CLI_API_CLIENT,
      "Accept": stream ? "text/event-stream" : "application/json"
    };
  }

  transformRequest(model, body, stream, credentials) {
    // Store model for use in buildHeaders (called by base.execute after transformRequest)
    this._currentModel = model;
    const streamlessBody = withoutTransportStream(body);
    // Cloud Code Assist wraps the Gemini payload: { project, model, request: <body> }
    if (streamlessBody && streamlessBody.request && streamlessBody.model) return streamlessBody;
    return {
      project: credentials?.projectId || streamlessBody?.project,
      model,
      request: streamlessBody
    };
  }

  // Parse RetryInfo.retryDelay from Google API 429 body to surface upstream retry hint.
  // parseUpstreamError only forwards resetsAtMs, so convert the Duration here.
  parseError(response, bodyText) {
    const base = super.parseError(response, bodyText);
    if (response.status !== 429 || !bodyText) return base;
    try {
      const parsed = JSON.parse(bodyText);
      const details = parsed?.error?.details;
      if (Array.isArray(details)) {
        for (const d of details) {
          if (d?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo" && d?.retryDelay) {
            base.retryAfter = d.retryDelay;
            const retryMs = retryDelayToMs(d.retryDelay);
            if (retryMs !== null && retryMs > 0) {
              base.resetsAtMs = Date.now() + retryMs;
            }
            break;
          }
        }
      }
    } catch {}
    return base;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    try {
      const response = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret
        }),
        identity: this.config.identity,
        provider: this.provider,
        format: this.config.format,
      }, proxyOptions);

      if (!response.ok) return null;

      const tokens = await response.json();
      log?.info?.("TOKEN", "Gemini CLI refreshed");

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credentials.refreshToken,
        expiresIn: tokens.expires_in,
        projectId: credentials.projectId
      };
    } catch (error) {
      log?.error?.("TOKEN", `Gemini CLI refresh error: ${error.message}`);
      return null;
    }
  }
}

export default GeminiCLIExecutor;
