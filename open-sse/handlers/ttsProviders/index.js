// TTS provider registry
import googleTts from "./googleTts.js";
import edgeTts, { fetchEdgeTtsVoices } from "./edgeTts.js";
import localDevice, { fetchLocalDeviceVoices } from "./localDevice.js";
import elevenlabs, { fetchElevenLabsVoices } from "./elevenlabs.js";
import openai from "./openai.js";
import openrouter from "./openrouter.js";
import gemini, { fetchGeminiVoices } from "./gemini.js";
import { FORMAT_HANDLERS } from "./genericFormats.js";
import { parseModelVoice } from "./_base.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "../../providers/index.js";

// Special providers with custom synthesize() logic
const SPECIAL_ADAPTERS = {
  "google-tts": googleTts,
  "edge-tts": edgeTts,
  "local-device": localDevice,
  elevenlabs,
  openai,
  openrouter,
  gemini,
};

export function getTtsAdapter(provider) {
  return SPECIAL_ADAPTERS[provider] || null;
}

// Generic config-driven dispatcher (uses ttsConfig.format)
export async function synthesizeViaConfig(provider, text, model, credentials, options = {}) {
  const cfg = PROVIDER_MEDIA[provider]?.ttsConfig;
  if (!cfg) return null;
  const handler = FORMAT_HANDLERS[cfg.format];
  if (!handler) return null;
  const apiKey = credentials?.apiKey;
  if (cfg.authType !== "none" && !apiKey) throw new Error(`${provider} API key required`);
  const ttsModels = (PROVIDER_MODELS[provider] || []).filter(m => (m.kind || m.type) === "tts");
  const defaultModel = ttsModels[0]?.id || "";
  const { modelId, voiceId } = parseModelVoice(model, defaultModel, "", ttsModels);
  return handler({ provider, baseUrl: cfg.baseUrl, apiKey, text, modelId, voiceId, ...options });
}

// Voice fetchers (used by /api/media-providers/tts/voices route)
export const VOICE_FETCHERS = {
  "edge-tts": fetchEdgeTtsVoices,
  "local-device": fetchLocalDeviceVoices,
  elevenlabs: fetchElevenLabsVoices,
  gemini: fetchGeminiVoices,
};

// Re-export for backward compat
export { fetchEdgeTtsVoices, fetchLocalDeviceVoices, fetchElevenLabsVoices, fetchGeminiVoices };
