// ElevenLabs TTS — voice id with optional model_id prefix
import { Buffer } from "node:buffer";
import { authenticatedMediaFetch } from "./_base.js";
import { proxyOptionsFromCredentials } from "../../utils/proxyFetch.js";

const VOICES_TTL = 24 * 60 * 60 * 1000;
// Bound keyed entries — TTL alone never evicts, so distinct keys accumulate.
export const ELEVENLABS_VOICES_CACHE_MAX = 100;
const _voicesCache = new Map(); // by API key

function cacheVoices(apiKey, voices) {
  _voicesCache.delete(apiKey);
  _voicesCache.set(apiKey, { voices, time: Date.now() });
  while (_voicesCache.size > ELEVENLABS_VOICES_CACHE_MAX) {
    _voicesCache.delete(_voicesCache.keys().next().value);
  }
}

export async function fetchElevenLabsVoices(apiKey) {
  if (!apiKey) throw new Error("ElevenLabs API key required");
  const now = Date.now();
  const cached = _voicesCache.get(apiKey);
  if (cached && now - cached.time < VOICES_TTL) return cached.voices;

  const res = await authenticatedMediaFetch("elevenlabs", "tts", "https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`ElevenLabs voices fetch failed: ${res.status}`);
  const data = await res.json();
  // Normalize: derive lang from labels for grouping
  const voices = (data.voices || []).map((v) => ({ ...v, lang: v.labels?.language || "en" }));
  cacheVoices(apiKey, voices);
  return voices;
}

const moduleDefault = {
  async synthesize(text, model, credentials, _responseFormat, opts = {}) {
    if (!credentials?.apiKey) throw new Error("ElevenLabs API key required");
    let modelId = "eleven_flash_v2_5";
    let voiceId = model;
    if (model && model.includes("/")) [modelId, voiceId] = model.split("/");

    const res = await authenticatedMediaFetch("elevenlabs", "tts", `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": credentials.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: opts?.signal,
      proxyOptions: proxyOptionsFromCredentials(credentials),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.detail?.message || `ElevenLabs TTS failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1024) throw new Error("ElevenLabs TTS returned empty audio");
    return { base64: Buffer.from(buf).toString("base64"), format: "mp3" };
  },
};

export default moduleDefault;
