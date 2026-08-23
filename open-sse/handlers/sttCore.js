import { Buffer } from "node:buffer";
import { createErrorResult } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { PROVIDERS, PROVIDER_MEDIA } from "../providers/index.js";

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
    case "key":        return { "Authorization": `Key ${token}` };
    default:           return { "Authorization": `Bearer ${token}` };
  }
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error("STT request aborted"), { name: "AbortError" });
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
async function transcribeDeepgram(cfg, file, model, token, formData, transport, abortSignal) {
  const url = new URL(cfg.baseUrl);
  url.searchParams.set("model", model);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  const lang = formData.get("language");
  if (typeof lang === "string" && lang.trim()) url.searchParams.set("language", lang.trim());
  else url.searchParams.set("detect_language", "true");

  const buf = await file.arrayBuffer();
  throwIfAborted(abortSignal);
  const res = await proxyAwareFetch(url, {
    method: "POST",
    headers: { ...buildAuthHeaders(cfg, token), "Content-Type": resolveAudioContentType(file) },
    body: buf,
    ...transport,
    signal: abortSignal,
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return jsonResponse({ text });
}

// AssemblyAI: upload → submit → poll (max 120s)
async function transcribeAssemblyAI(cfg, file, model, token, transport, abortSignal) {
  const auth = buildAuthHeaders(cfg, token);
  const buf = await file.arrayBuffer();
  throwIfAborted(abortSignal);
  const up = await proxyAwareFetch("https://api.assemblyai.com/v2/upload", {
    method: "POST", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: buf, ...transport, signal: abortSignal,
  });
  if (!up.ok) return upstreamError(up);
  const { upload_url } = await up.json();

  const sub = await proxyAwareFetch(cfg.baseUrl, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: upload_url, speech_models: [model], language_detection: true }),
    ...transport,
    signal: abortSignal,
  });
  if (!sub.ok) return upstreamError(sub);
  const { id } = await sub.json();

  const start = Date.now();
  while (Date.now() - start < 120_000) {
    await abortableDelay(2000, abortSignal);
    const poll = await proxyAwareFetch(`${cfg.baseUrl}/${id}`, { headers: auth, ...transport, signal: abortSignal });
    if (!poll.ok) continue;
    const r = await poll.json();
    if (r.status === "completed") return jsonResponse({ text: r.text || "" });
    if (r.status === "error") return createErrorResult(500, r.error || "AssemblyAI failed");
  }
  return createErrorResult(504, "AssemblyAI timeout after 120s");
}

// Nvidia NIM: multipart, normalize response
async function transcribeNvidia(cfg, file, model, token, transport, abortSignal) {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.append("model", model);
  const res = await proxyAwareFetch(cfg.baseUrl, { method: "POST", headers: buildAuthHeaders(cfg, token), body: fd, ...transport, signal: abortSignal });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  return jsonResponse({ text: data.text || data.transcript || "" });
}

// Gemini: generateContent with inline_data audio + transcription prompt
async function transcribeGemini(cfg, file, model, token, formData, transport, abortSignal) {
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

  const url = `${cfg.baseUrl}/${model}:generateContent?key=${token}`;
  const res = await proxyAwareFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mime, data: b64 } }] }],
    }),
    ...transport,
    signal: abortSignal,
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
  return jsonResponse({ text });
}

// HuggingFace: POST raw binary to {baseUrl}/{model_id}
async function transcribeHuggingFace(cfg, file, model, token, transport, abortSignal) {
  if (model.includes("..") || model.includes("//")) return createErrorResult(400, "Invalid model ID");
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/${model}`;
  const buf = await file.arrayBuffer();
  throwIfAborted(abortSignal);
  const res = await proxyAwareFetch(url, {
    method: "POST",
    headers: { ...buildAuthHeaders(cfg, token), "Content-Type": resolveAudioContentType(file) },
    body: buf,
    ...transport,
    signal: abortSignal,
  });
  if (!res.ok) return upstreamError(res);
  const data = await res.json();
  return jsonResponse({ text: data.text || "" });
}

// Default: OpenAI/Groq/Whisper-compatible multipart
async function transcribeOpenAICompatible(cfg, file, model, token, formData, transport, abortSignal) {
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.wav");
  fd.append("model", model);
  for (const k of ["language", "prompt", "response_format", "temperature"]) {
    const v = formData.get(k);
    if (v !== null && v !== undefined && v !== "") fd.append(k, v);
  }
  const res = await proxyAwareFetch(cfg.baseUrl, { method: "POST", headers: buildAuthHeaders(cfg, token), body: fd, ...transport, signal: abortSignal });
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

/**
 * STT core handler — dispatch by sttConfig.format.
 * @returns {Promise<{success, response, status?, error?}>}
 */
export async function handleSttCore({ provider, model, formData, credentials, sttConfig, abortSignal }) {
  const file = formData.get("file");
  if (!file) return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  let cfg = sttConfig;
  if (!cfg) return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support STT`);

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

  const token = isSelfHosted
    ? (credentials?.apiKey || credentials?.accessToken)
    : cfg.authType === "none" ? null : (credentials?.apiKey || credentials?.accessToken);
  if (!isSelfHosted && cfg.authType !== "none" && !token) {
    return createErrorResult(HTTP_STATUS.UNAUTHORIZED, `No credentials for STT provider: ${provider}`);
  }
  const transport = sttTransport(provider, cfg);

  try {
    switch (cfg.format) {
      case "deepgram":        return await transcribeDeepgram(cfg, file, model, token, formData, transport, abortSignal);
      case "assemblyai":      return await transcribeAssemblyAI(cfg, file, model, token, transport, abortSignal);
      case "nvidia-asr":      return await transcribeNvidia(cfg, file, model, token, transport, abortSignal);
      case "huggingface-asr": return await transcribeHuggingFace(cfg, file, model, token, transport, abortSignal);
      case "gemini-stt":      return await transcribeGemini(cfg, file, model, token, formData, transport, abortSignal);
      default:                return await transcribeOpenAICompatible(cfg, file, model, token, formData, transport, abortSignal);
    }
  } catch (err) {
    if (err?.name === "AbortError" || abortSignal?.aborted) return createErrorResult(499, "STT request aborted");
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, err.message || "STT request failed");
  }
}
