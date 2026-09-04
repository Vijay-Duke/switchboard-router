// OpenRouter TTS — via chat completions + audio modality (SSE stream)
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { authenticatedMediaFetch } from "./_base.js";
import { proxyOptionsFromCredentials } from "../../utils/proxyFetch.js";

const TTS_CFG = PROVIDER_MEDIA["openrouter"]?.ttsConfig || {};

const moduleDefault = {
  async synthesize(text, model, credentials, _responseFormat, opts = {}) {
    if (!credentials?.apiKey) throw new Error("No OpenRouter API key configured");

    // model format: "tts-model/voice" e.g. "gpt-4o-mini-tts/alloy" or
    // "openai/gpt-4o-mini-tts/alloy" — split on the LAST slash so both work.
    let ttsModel = TTS_CFG.defaultModel;
    let voice = "alloy";
    if (model && model.includes("/")) {
      const lastSlash = model.lastIndexOf("/");
      ttsModel = model.slice(0, lastSlash) || ttsModel;
      voice = model.slice(lastSlash + 1) || voice;
    } else if (model) {
      voice = model;
    }

    const res = await authenticatedMediaFetch("openrouter", "tts", TTS_CFG.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${credentials.apiKey}`,
      },
      body: JSON.stringify({
        model: ttsModel,
        modalities: ["text", "audio"],
        audio: { voice, format: "wav" },
        stream: true,
        messages: [{ role: "user", content: text }],
      }),
      signal: opts?.signal,
      proxyOptions: proxyOptionsFromCredentials(credentials),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenRouter TTS failed: ${res.status}`);
    }

    // Parse SSE stream, accumulate base64 audio chunks
    const chunks = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const json = JSON.parse(line.slice(6));
          const audioData = json.choices?.[0]?.delta?.audio?.data;
          if (audioData) chunks.push(audioData);
        } catch {}
      }
    }

    if (chunks.length === 0) throw new Error("OpenRouter TTS returned no audio data");
    return { base64: chunks.join(""), format: "wav" };
  },
};

export default moduleDefault;
