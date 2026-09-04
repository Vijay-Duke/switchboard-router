// OpenAI TTS — model format: "tts-model/voice"
import { Buffer } from "node:buffer";
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { authenticatedMediaFetch, parseModelVoice } from "./_base.js";
import { proxyOptionsFromCredentials } from "../../utils/proxyFetch.js";

const DEFAULT_TTS_MODEL = PROVIDER_MEDIA["openai"]?.ttsConfig?.defaultModel;

const moduleDefault = {
  async synthesize(text, model, credentials, _responseFormat, opts = {}) {
    if (!credentials?.apiKey) throw new Error("No OpenAI API key configured");

    const { modelId, voiceId } = parseModelVoice(model, DEFAULT_TTS_MODEL, "");
    const ttsModel = modelId || DEFAULT_TTS_MODEL;
    const voice = voiceId || "alloy";

    const baseUrl = (credentials.baseUrl || "https://api.openai.com").replace(/\/+$/, "");
    const res = await authenticatedMediaFetch("openai", "tts", `${baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${credentials.apiKey}` },
      body: JSON.stringify({ model: ttsModel, voice, input: text }),
      signal: opts?.signal,
      proxyOptions: proxyOptionsFromCredentials(credentials),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI TTS failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    return { base64: Buffer.from(buf).toString("base64"), format: "mp3" };
  },
};

export default moduleDefault;
