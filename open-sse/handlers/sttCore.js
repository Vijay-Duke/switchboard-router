import { Buffer } from "node:buffer";
import { createErrorResult } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { proxyAwareFetch, proxyOptionsFromCredentials, resolveProxyUrl, getDispatcher } from "../utils/proxyFetch.js";
import { PROVIDERS, PROVIDER_MEDIA } from "../providers/index.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "../config/providerModels.js";
import { transcribeGeminiLive } from "./geminiLiveStt.js";
import { transcribeCodex } from "./codexStt.js";

function sttTransport(provider, cfg) {
  const transport = PROVIDERS[provider] || {};
  const config = PROVIDER_MEDIA[provider]?.sttConfig || cfg || {};
  return {
    identity: config.identity || transport.identity || "openai-node",
    provider,
    format: config.format || transport.format || "openai",
  };
}

// Build auth headers from sttConfig + token
function buildAuthHeaders(cfg, token) {
  if (!token) return {};
  switch (cfg.authHeader) {
    case "bearer":     return { "Authorization": `Bearer ${token}` };
    case "token":      return { "Authorization": `Token ${token}` };
    case "x-api-key":  return { "x-api-key": token };
    case "xi-api-key": return { "xi-api-key": token };
    case "key":        return { "Authorization": `Key ${token}` };
    default:           return { "Authorization": `Bearer ${token}` };
  }
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error("STT request aborted"), { name: "AbortError" });
}

// Uploads fully buffer in memory — refuse absurd files before arrayBuffer().
const STT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function assertUploadSize(file) {
  const size = typeof file?.size === "number" ? file.size : null;
  if (size != null && size > STT_MAX_UPLOAD_BYTES) {
    const error = new Error(`audio file exceeds ${STT_MAX_UPLOAD_BYTES} bytes`);
    error.status = 413;
    throw error;
  }
}

function abortableDelay(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(Object.assign(new Error("STT request aborted"), { name: "AbortError" }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("STT request aborted"), { name: "AbortError" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}


// Map browser file MIME / ext → audio MIME for binary formats (deepgram/HF)
function resolveAudioContentType(file) {
  const t = (file.type || "").toLowerCase();
  if (t.startsWith("audio/")) return t;
  const name = typeof file.name === "string" ? file.name.toLowerCase() : "";
  const ext = name.includes(".") ? name.split(".").pop() : "";
  const map = { mp3: "audio/mpeg", mp4: "audio/mp4", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm", aac: "audio/aac", opus: "audio/opus" };
  return map[ext] || "application/octet-stream";
}

async function upstreamError(res) {
  let txt = "";
  try { txt = await res.text(); } catch {}
  let msg = txt || `Upstream error (${res.status})`;
  try { const j = JSON.parse(txt); msg = j?.error?.message || j?.error || j?.message || msg; } catch {}
  return createErrorResult(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
}

// Deepgram: raw binary POST + model query param
async function transcribeDeepgram(cfg, file, model, token, formData, transport, abortSignal, proxyOptions) {
  const url = new URL(cfg.baseUrl);
  url.searchParams.set("model", model);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  const lang = formData.get("language");
  if (typeof lang === "string" && lang.trim()) url.searchParams.set("language", lang.trim());
  else url.searchParams.set("detect_language", "true");

  assertUploadSize(file);
  const buf = await file.arrayBuffer();
  throwIfAborted(abortSignal);
  const res = await proxyAwareFetch(url, {
    method: "POST",
    headers: { ...buildAuthHeaders(cfg, token), "Content-Type": resolveAudioContentType(file) },
    body: buf,
    ...transport,
    signal: abortSignal,
  }, proxyOptions);
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return jsonResponse({ text });
}

// AssemblyAI: upload → submit → poll (max 120s)
async function transcribeAssemblyAI(cfg, file, model, token, transport, abortSignal, proxyOptions) {
  const auth = buildAuthHeaders(cfg, token);
  assertUploadSize(file);
  const buf = await file.arrayBuffer();
  throwIfAborted(abortSignal);
  const up = await proxyAwareFetch("https://api.assemblyai.com/v2/upload", {
    method: "POST", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: buf, ...transport, signal: abortSignal,
  }, proxyOptions);
  if (!up.ok) return upstreamError(up);
  const { upload_url } = await up.json();

  const sub = await proxyAwareFetch(cfg.baseUrl, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: upload_url, speech_models: [model], language_detection: true }),
    ...transport,
    signal: abortSignal,
  }, proxyOptions);
  if (!sub.ok) return upstreamError(sub);
  const { id } = await sub.json();

  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await abortableDelay(2000, abortSignal);
    const poll = await proxyAwareFetch(`${cfg.baseUrl}/${id}`, { headers: auth, ...transport, signal: abortSignal }, proxyOptions);
    // Auth failures are permanent — fail fast instead of retrying for 120s.
    if (!poll.ok) {
      if (poll.status === 401 || poll.status === 403 || poll.status === 404) return upstreamError(poll);
      continue;
    }
    const r = await poll.json();
    if (r.status === "completed") return jsonResponse({ text: r.text || "" });
    if (r.status === "error") return createErrorResult(500, r.error || "AssemblyAI failed");
  }
  return createErrorResult(504, "AssemblyAI timeout after 120s");
}

// Nvidia NIM: multipart, normalize response
async function transcribeNvidia(cfg, file, model, token, transport, abortSignal, proxyOptions) {
  assertUploadSize(file);
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.append("model", model);
  const res = await proxyAwareFetch(cfg.baseUrl, { method: "POST", headers: buildAuthHeaders(cfg, token), body: fd, ...transport, signal: abortSignal }, proxyOptions);
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  return jsonResponse({ text: data.text || data.transcript || "" });
}

// Gemini: generateContent with inline_data audio + transcription prompt
async function transcribeGemini(cfg, file, model, token, formData, transport, abortSignal, proxyOptions) {
  assertUploadSize(file);
  const buf = await file.arrayBuffer();
  throwIfAborted(abortSignal);
  const b64 = Buffer.from(buf).toString("base64");
  const mime = resolveAudioContentType(file);
  const lang = formData.get("language");
  const userPrompt = formData.get("prompt");
  let promptText = userPrompt && typeof userPrompt === "string" && userPrompt.trim()
    ? userPrompt.trim()
    : "Generate a transcript of the speech. Return only the transcribed text, no commentary.";
  if (typeof lang === "string" && lang.trim()) promptText += ` Language: ${lang.trim()}.`;

  const url = `${cfg.baseUrl}/${model}:generateContent?key=${encodeURIComponent(token)}`;
  const res = await proxyAwareFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mime, data: b64 } }] }],
    }),
    ...transport,
    signal: abortSignal,
  }, proxyOptions);
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  return jsonResponse({ text });
}

// ElevenLabs Scribe: multipart POST /v1/speech-to-text (xi-api-key).
// Optional renderings (srt/vtt/seg_json) come back as `additional_formats`; the
// requested one is served verbatim instead of being fabricated from the JSON body.
async function transcribeElevenLabs(cfg, file, model, token, formData, transport, abortSignal, proxyOptions) {
  assertUploadSize(file);
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.append("model_id", model);

  const get = (k) => {
    const v = formData?.get?.(k);
    return typeof v === "string" ? v.trim() : "";
  };
  // Blank language_code → upstream auto-detect, so the field is omitted entirely.
  const language = get("language");
  if (language) fd.append("language_code", language);

  const granularity = get("timestamps_granularity");
  if (["word", "character", "none"].includes(granularity)) {
    fd.append("timestamps_granularity", granularity);
  }
  if (get("tag_audio_events") === "true") fd.append("tag_audio_events", "true");

  // diarize and num_speakers are mutually exclusive upstream; diarize wins when both
  // are sent so the request stays valid instead of erroring.
  const numSpeakers = get("num_speakers");
  const num = Number(numSpeakers);
  if (get("diarize") === "true") {
    fd.append("diarize", "true");
  } else if (Number.isInteger(num) && num >= 1 && num <= 32) {
    fd.append("num_speakers", String(num));
  }

  const fmt = get("response_format").toLowerCase() || "json";
  const formats = cfg.responseFormats || {};
  // subtitle/caption formats are returned as raw text, not a JSON envelope
  const rawFormat = { srt: formats.subtitles, vtt: formats.captions }[fmt];
  const extraFormat = rawFormat || (fmt === "verbose_json" ? formats.segments : null);
  if (extraFormat) {
    fd.append("additional_formats", JSON.stringify([{ format: extraFormat }]));
  }

  const res = await proxyAwareFetch(cfg.baseUrl, { method: "POST", headers: buildAuthHeaders(cfg, token), body: fd, ...transport, signal: abortSignal }, proxyOptions);
  if (!res.ok) return upstreamError(res);

  const data = await res.json();
  const text = typeof data?.text === "string" ? data.text : "";
  const segments = extractAdditionalFormat(data, extraFormat);

  if (rawFormat) return textResponse(segments ?? text);
  if (fmt === "verbose_json") {
    return jsonResponse({
      text,
      language: data?.language_code ?? null,
      ...(data?.language_probability != null ? { language_probability: data.language_probability } : {}),
      ...(Array.isArray(data?.words) ? { words: data.words } : {}),
      ...(data?.num_speakers != null ? { num_speakers: data.num_speakers } : {}),
      // Real segments only when the upstream render was requested — never
      // synthesized, so transports diffed by clients don't show invented timings.
      ...(segments ? { segments } : {}),
    });
  }
  if (fmt === "text") return textResponse(text);
  return jsonResponse({ text });
}

// ElevenLabs returns `additional_formats[].content` as a plain string (srt/vtt) or
// as a JSON *string* holding the segment render (seg_json). Returns null when the
// render is absent or unparseable so callers can fall back rather than guess.
function extractAdditionalFormat(data, format) {
  if (!format || !Array.isArray(data?.additional_formats)) return null;
  const content = data.additional_formats.find((f) => f?.format === format)?.content;
  if (typeof content !== "string") return null;
  if (format !== "seg_json") return content;
  try { return JSON.parse(content); } catch { return null; }
}

function textResponse(body) {
  return {
    success: true,
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
  };
}

// HuggingFace: POST raw binary to {baseUrl}/{model_id}
async function transcribeHuggingFace(cfg, file, model, token, transport, abortSignal, proxyOptions) {
  if (model.includes("..") || model.includes("//")) return createErrorResult(400, "Invalid model ID");
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/${model}`;
  assertUploadSize(file);
  const buf = await file.arrayBuffer();
  throwIfAborted(abortSignal);
  const res = await proxyAwareFetch(url, {
    method: "POST",
    headers: { ...buildAuthHeaders(cfg, token), "Content-Type": resolveAudioContentType(file) },
    body: buf,
    ...transport,
    signal: abortSignal,
  }, proxyOptions);
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  return jsonResponse({ text: data.text || "" });
}

// Default: OpenAI/Groq/Whisper-compatible multipart
async function transcribeOpenAICompatible(cfg, file, model, token, formData, transport, abortSignal, proxyOptions) {
  assertUploadSize(file);
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.append("model", model);
  for (const k of ["language", "prompt", "response_format", "temperature"]) {
    const v = formData.get(k);
    if (v !== null && v !== undefined && v !== "") fd.append(k, v);
  }
  const res = await proxyAwareFetch(cfg.baseUrl, { method: "POST", headers: buildAuthHeaders(cfg, token), body: fd, ...transport, signal: abortSignal }, proxyOptions);
  if (!res.ok) return upstreamError(res);
  const ct = res.headers.get("content-type") || "application/json";
  const txt = await res.text();
  return { success: true, response: new Response(txt, { status: 200, headers: { "Content-Type": ct } }) };
}

function jsonResponse(obj) {
  return {
    success: true,
    response: new Response(JSON.stringify(obj), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

// Model-level transport marker (registry models[].transport, e.g. the Gemini
// live STT entry's "gemini-live", or a custom model's stored transport).
// Dispatch reads the marker — never a hardcoded model id — so new realtime
// providers extend sttCore through data, not code.
function resolveModelTransport(provider, model) {
  const key = PROVIDER_ID_TO_ALIAS[provider] || provider;
  const models = PROVIDER_MODELS[key] || PROVIDER_MODELS[provider];
  if (!Array.isArray(models)) return null;
  const entry = models.find((m) => m && m.id === model && (m.kind || "llm") === "stt");
  const marker = typeof entry?.transport === "string" ? entry.transport.trim() : "";
  return marker || null;
}

/**
 * STT core handler — dispatch by model transport marker, else sttConfig.format.
 * `transport` is the caller-supplied marker override (custom models resolve
 * it in the app layer; built-ins fall back to the registry entry marker).
 * @returns {Promise<{success, response, status?, error?}>}
 */
export async function handleSttCore({ provider, model, formData, credentials, sttConfig, transport, abortSignal }) {
  const file = formData.get("file");
  if (!file) return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  let cfg = sttConfig;
  if (!cfg) return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support STT`);

  // Codex OAuth transcription uses a fixed ChatGPT endpoint with its own
  // identity/proxy plumbing (Bearer OAuth token + account header) — the
  // generic token and endpoint handling never applies, and connection URL
  // overrides are deliberately ignored.
  if (provider === "codex" && cfg.format === "codex-transcribe") {
    return transcribeCodex({ formData, credentials, abortSignal, proxyOptions: proxyOptionsFromCredentials(credentials) });
  }

  const isSelfHosted = provider === "selfhosted-stt";
  if (isSelfHosted) {
    const baseUrl = credentials?.providerSpecificData?.baseUrl?.trim();
    if (!baseUrl) return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Self-hosted STT requires a connection base URL");
    try {
      if (!["http:", "https:"].includes(new URL(baseUrl).protocol)) throw new Error();
    } catch {
      return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Self-hosted STT base URL must use http or https");
    }
    cfg = { ...cfg, baseUrl: baseUrl.replace(/\/+$/, "") };
  }

  const token = isSelfHosted || cfg.authType !== "none"
    ? (credentials?.apiKey || credentials?.accessToken)
    : null;
  if (!isSelfHosted && cfg.authType !== "none" && !token) {
    return createErrorResult(HTTP_STATUS.UNAUTHORIZED, `No credentials for STT provider: ${provider}`);
  }
  const transportOpts = sttTransport(provider, cfg);
  const proxyOptions = proxyOptionsFromCredentials(credentials);

  // Format-switch extension: an explicit caller marker wins over the registry
  // marker; with neither, the provider-default sttConfig.format applies.
  const marker = (typeof transport === "string" && transport.trim()) ? transport.trim() : resolveModelTransport(provider, model);

  try {
    switch (marker || cfg.format) {
      case "gemini-live": {
        if (proxyOptions?.vercelRelayUrl) throw Object.assign(new Error("Gemini Live requires a WebSocket-capable proxy; HTTP relay transport is unsupported"), { status: 502 });
        // Same egress as the REST hops: per-connection proxy, else env proxy.
        // A proxy-dial failure falls back to a direct WS connection (the
        // fetch transports degrade the same way when the agent is unusable).
        let dispatcher = null;
        try {
          const proxyUrl = resolveProxyUrl(cfg.baseUrl, proxyOptions);
          if (proxyUrl) dispatcher = await getDispatcher(proxyUrl);
        } catch (error) {
          if (proxyOptions?.strictProxy) throw Object.assign(new Error(`Gemini Live proxy failed: ${error.message}`), { status: 502 });
        }
        const live = await transcribeGeminiLive({ cfg, file, model, token, formData, mimeType: resolveAudioContentType(file), ...(dispatcher ? { dispatcher } : {}), abortSignal });
        // response_format parity with the OpenAI-compatible transport: default
        // envelope stays {text}; verbose_json adds segments mapped from the
        // Live API's incremental inputTranscription deltas. Those frames carry
        // NO timestamps, so segments expose {id,text} only (id = delta order,
        // Whisper-compatible 0-based) — start/end/duration are deliberately
        // absent rather than fabricated as zeros, which would misrepresent
        // provider data to callers diffing transports.
        const fmt = typeof formData?.get === "function"
          ? String(formData.get("response_format") ?? "").trim().toLowerCase()
          : "";
        if (fmt === "verbose_json") {
          return jsonResponse({ text: live.text, segments: live.chunks.map((segText, id) => ({ id, text: segText })) });
        }
        return jsonResponse({ text: live.text });
      }
      case "deepgram":        return await transcribeDeepgram(cfg, file, model, token, formData, transportOpts, abortSignal, proxyOptions);
      case "assemblyai":      return await transcribeAssemblyAI(cfg, file, model, token, transportOpts, abortSignal, proxyOptions);
      case "nvidia-asr":      return await transcribeNvidia(cfg, file, model, token, transportOpts, abortSignal, proxyOptions);
      case "huggingface-asr": return await transcribeHuggingFace(cfg, file, model, token, transportOpts, abortSignal, proxyOptions);
      case "gemini-stt":      return await transcribeGemini(cfg, file, model, token, formData, transportOpts, abortSignal, proxyOptions);
      case "elevenlabs-stt":  return await transcribeElevenLabs(cfg, file, model, token, formData, transportOpts, abortSignal, proxyOptions);
      default:                return await transcribeOpenAICompatible(cfg, file, model, token, formData, transportOpts, abortSignal, proxyOptions);
    }
  } catch (err) {
    if (err?.name === "AbortError" || abortSignal?.aborted) return createErrorResult(499, "STT request aborted");
    // Validation errors carry an explicit status (e.g. 413 oversize upload).
    const status = Number(err?.status);
    if (Number.isInteger(status) && status >= 400 && status < 600) return createErrorResult(status, err.message || "STT request failed");
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, err.message || "STT request failed");
  }
}
