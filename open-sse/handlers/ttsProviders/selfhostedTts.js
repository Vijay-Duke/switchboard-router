import { createErrorResult } from "../../utils/error.js";
import { authenticatedMediaFetch, responseToBase64, throwUpstreamError } from "./_base.js";

const moduleDefault = {
  async synthesize(text, model, credentials, responseFormat = "mp3") {
    const raw = credentials?.providerSpecificData?.baseUrl?.trim();
    if (!raw) return createErrorResult(400, "Self-hosted TTS requires a connection base URL");

    const parsed = new URL(raw);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      return createErrorResult(400, "Self-hosted TTS base URL must use http or https");
    }
    const base = raw.replace(/\/+$/, "");
    const url = base.endsWith("/v1/audio/speech")
      ? base
      : base.endsWith("/v1") ? `${base}/audio/speech` : `${base}/v1/audio/speech`;
    const [ttsModel = "kokoro", ...voiceParts] = String(model || "kokoro").split("/");
    const audioFormat = responseFormat === "json" ? "mp3" : responseFormat;
    const headers = { "Content-Type": "application/json" };
    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await authenticatedMediaFetch("selfhosted-tts", "tts", url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: ttsModel,
        voice: voiceParts.join("/") || "af_heart",
        input: text,
        response_format: audioFormat,
      }),
    });
    if (!res.ok) await throwUpstreamError(res);
    return responseToBase64(res, audioFormat);
  },
};

export default moduleDefault;
