import { createErrorResult } from "../../utils/error.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { authenticatedMediaFetch, responseToBase64, throwUpstreamError } from "./_base.js";

const TTS_CONFIG = PROVIDER_MEDIA["selfhosted-tts"]?.ttsConfig || {};

const moduleDefault = {
  async synthesize(text, model, credentials, responseFormat = "mp3", options = {}) {
    const raw = credentials?.providerSpecificData?.baseUrl?.trim();
    if (!raw) return createErrorResult(400, "Self-hosted TTS requires a connection base URL");

    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return createErrorResult(400, "Self-hosted TTS base URL must use http or https");
    }
    const base = raw.replace(/\/+$/, "");
    const url = base.endsWith("/v1/audio/speech")
      ? base
      : base.endsWith("/v1") ? `${base}/audio/speech` : `${base}/v1/audio/speech`;
    const [ttsModel = TTS_CONFIG.defaultModel, ...voiceParts] = String(model || TTS_CONFIG.defaultModel).split("/");
    const audioFormat = responseFormat === "json" ? "mp3" : responseFormat;
    const headers = { "Content-Type": "application/json" };
    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await authenticatedMediaFetch("selfhosted-tts", "tts", url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: ttsModel,
        voice: voiceParts.join("/") || TTS_CONFIG.defaultVoice,
        input: text,
        response_format: audioFormat,
      }),
      signal: options.signal,
    });
    if (!res.ok) await throwUpstreamError(res);
    return responseToBase64(res, audioFormat);
  },
};

export default moduleDefault;
