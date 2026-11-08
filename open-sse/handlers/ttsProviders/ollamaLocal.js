import { resolveOllamaLocalHost } from "../../config/providers.js";
import { authenticatedMediaFetch, responseToBase64, throwUpstreamError } from "./_base.js";
import { proxyOptionsFromCredentials } from "../../utils/proxyFetch.js";

const DEFAULT_MODEL = "phonon:multilingual";
const DEFAULT_VOICE = "default";

// `model` arrives as "phonon-tag", "phonon-tag/voice" or a bare voice name
// ("Zoey") — resolve it into the Ollama tag + voice pair.
function parsePhononTarget(model) {
  let ttsModel = DEFAULT_MODEL;
  let voice = DEFAULT_VOICE;
  if (model) {
    const parts = String(model).split("/").filter(Boolean);
    if (parts.length >= 2) {
      ttsModel = parts[0];
      voice = parts.slice(1).join("/");
    } else if (parts.length === 1) {
      const val = parts[0];
      if (val.startsWith("phonon")) {
        ttsModel = val;
      } else {
        // Bare non-phonon name → voice on the default multilingual model
        voice = val;
      }
    }
  }
  return { ttsModel, voice };
}

const moduleDefault = {
  async synthesize(text, model, credentials, responseFormat = "mp3", options = {}) {
    // Strip trailing slashes and any path suffix so the saved connection URL
    // may be the bare host, ".../v1" or the full speech endpoint.
    const host = String(resolveOllamaLocalHost(credentials))
      .replace(/\/+$/, "")
      .replace(/\/v1\/audio\/speech$/, "")
      .replace(/\/v1$/, "");
    const { ttsModel, voice } = parsePhononTarget(model);

    // Ollama /v1/audio/speech natively supports "wav" or "pcm" only; anything
    // else (mp3/json/unspecified) is requested as wav and relabeled by the
    // response content type.
    const upstreamFormat = responseFormat === "pcm" ? "pcm" : "wav";

    const payload = {
      model: ttsModel,
      input: text,
      voice,
      response_format: upstreamFormat,
    };

    const headers = { "Content-Type": "application/json" };
    if (credentials?.apiKey) {
      headers.Authorization = `Bearer ${credentials.apiKey}`;
    }
    const proxyOptions = proxyOptionsFromCredentials(credentials);
    const signal = options.signal || null;
    const request = (body) => authenticatedMediaFetch("ollama-local", "tts", `${host}/v1/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      proxyOptions,
    });

    let currentModel = ttsModel;
    let res;
    try {
      res = await request(payload);

      // Requested phonon tag not installed (404) → discover another installed
      // phonon tag via /api/tags, else try the common counterparts.
      if (!res.ok && res.status === 404 && ttsModel.startsWith("phonon")) {
        let altModel = null;
        try {
          const tagsRes = await authenticatedMediaFetch("ollama-local", "tts", `${host}/api/tags`, {
            proxyOptions,
            signal,
          });
          if (tagsRes.ok) {
            const data = await tagsRes.json().catch(() => ({}));
            const installed = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
            altModel = installed.find((m) => m.startsWith("phonon") && m !== ttsModel) || null;
          }
        } catch {}

        if (!altModel) {
          altModel = ttsModel === "phonon" ? "phonon:multilingual" : ttsModel === "phonon:multilingual" ? "phonon:latest" : null;
        }

        if (altModel) {
          const retryRes = await request({ ...payload, model: altModel });
          if (retryRes.ok) return responseToBase64(retryRes, upstreamFormat);
          // A 400 here (voice missing from this checkpoint) falls through to
          // the voice fallback below.
          res = retryRes;
          currentModel = altModel;
        }
      }

      // Voice not supported by the loaded checkpoint (400) → retry with the default voice
      if (!res.ok && res.status === 400 && voice !== DEFAULT_VOICE) {
        const errText = await res.clone().text().catch(() => "");
        if (errText.includes("voice") && errText.includes("not found")) {
          const retryRes = await request({ ...payload, model: currentModel, voice: DEFAULT_VOICE });
          if (retryRes.ok) return responseToBase64(retryRes, upstreamFormat);
        }
      }
    } catch (err) {
      if (err?.cause?.code === "ECONNREFUSED" || err?.code === "ECONNREFUSED" || err?.message?.includes("fetch failed")) {
        throw new Error(`Cannot connect to Ollama at ${host}. Please ensure Ollama is running (e.g. 'ollama serve').`);
      }
      throw err;
    }

    if (!res.ok) {
      await throwUpstreamError(res);
    }

    return responseToBase64(res, upstreamFormat);
  },
};

export default moduleDefault;
