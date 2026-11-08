import { Buffer } from "node:buffer";
import { convertAudio, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS } from "./codexSttAudio.js";

// Gemini Live API realtime STT transport.
//
// The REST generateContent path (sttCore.transcribeGemini) only transcribes
// whole files inline. The Live API's `:bidiGenerateContent` WebSocket is the
// streaming counterpart: audio goes up as realtimeInput mediaChunks and the
// server pushes incremental `serverContent.inputTranscription` events back.
// This module owns the socket lifecycle only — envelope/response shaping
// stays in sttCore so the engine's single STT exit shape is preserved.
//
// Marker contract: dispatched from sttCore's format-switch when the model
// entry carries `transport: "gemini-live"` (registry) or the caller passes a
// transport string (custom models). Never keyed on a hardcoded model id here.
//
// Transport behavior:
//   - Node >= 22 global WebSocket (undici); injectable for tests and
//     per-connection proxy dispatchers (undici WebSocket options object),
//     the same seam open-sse/executors/codexWsTransport.js exposes.
//   - Live API expects PCM16; other containers are decoded to 16kHz mono
//     with the same bounded ffmpeg helper used by Codex transcription.
//   - Text accumulation is append-only over inputTranscription segments and
//     ends on serverContent.turnComplete (or graceful close with partial text).
//   - Transcription deltas are kept per-frame (chunks[]) so sttCore can shape
//     verbose_json segments without fabricating timestamps. A server goAway
//     returns a retryable error rather than losing already-uploaded audio.

const SETUP_TIMEOUT_MS = 10_000;  // open → setupComplete
const TURN_TIMEOUT_MS = 60_000;   // audio streamed → turnComplete
const MAX_TIMEOUT_MS = 300_000;   // clamp ceiling for client-supplied lifecycle knobs
const CHUNK_BYTES = 16_384;       // ~0.5s of 16-bit 16kHz mono PCM

class GeminiLiveError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GeminiLiveError";
    this.status = status || 502;
  }
}

// Google Live uses an RPC WebSocket endpoint; the model belongs in setup,
// never in the URL. See https://ai.google.dev/api/live#websocket-connection.
function toLiveWsUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const version = /\/(v1(?:alpha|beta)?)\//.exec(url.pathname)?.[1] || "v1beta";
  url.pathname = `/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent`;
  url.search = "";
  url.searchParams.set("key", token || "");
  return url.toString();
}

// Bind socket events supporting BOTH handler styles: addEventListener
// (browser WebSocket, undici) and onopen/onmessage property assignment
// (minimal polyfills). Whichever the implementation exposes, it works.
function bindSocket(ws, { onOpen, onMessage, onError, onClose }) {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    return;
  }
  ws.onopen = onOpen;
  ws.onmessage = onMessage;
  ws.onerror = onError;
  ws.onclose = onClose;
}

function parseFrame(data) {
  try {
    return JSON.parse(typeof data === "string" ? data
      : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8")
        : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8") : String(data));
  } catch {
    return null; // non-JSON frames carry no Live API semantics
  }
}

function firstStringField(formData, key) {
  const v = typeof formData?.get === "function" ? formData.get(key) : null;
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

// Lifecycle knobs the live registry entry advertises in params[]
// (setup/turn timeouts). They ride the same formData pass-through sttCore
// gives every transport — no sttCore change needed to reach this leaf.
function firstNumberField(formData, key, fallback) {
  const n = Number(firstStringField(formData, key));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMEOUT_MS) : fallback;
}

/**
 * Transcribe an audio File via the Gemini Live bidirectional stream.
 * @param {object} options
 * @param {object} options.cfg - provider sttConfig (baseUrl, authType, ...)
 * @param {File} options.file - audio upload
 * @param {string} options.model - model id
 * @param {string} options.token - provider API key
 * @param {FormData} options.formData - original request form (prompt/language
 *   pass-through + lifecycle knobs)
 * @param {string} options.mimeType - resolved audio content type
 * @param {Function} [options.WebSocket] - injectable WebSocket class (tests)
 * @param {object} [options.dispatcher] - undici dispatcher (per-connection proxy)
 * @param {AbortSignal} [options.abortSignal] - client abort
 * @returns {Promise<{text: string, chunks: string[]}>} transcript plus the raw
 *   incremental inputTranscription deltas (sttCore shapes verbose_json from them).
 * @throws {GeminiLiveError} with .status for the sttCore error envelope.
 */
export async function transcribeGeminiLive({ cfg, file, model, token, formData, mimeType, WebSocket = globalThis.WebSocket, dispatcher, abortSignal }) {
  const WS = WebSocket || (await import("undici")).WebSocket;
  if (typeof WS !== "function") {
    throw new GeminiLiveError("Gemini Live transport needs global WebSocket (Node >= 22)", 502);
  }

  if (file.size > MAX_AUDIO_BYTES) throw new GeminiLiveError("Audio exceeds size limit", 413);
  // The Live service accepts raw PCM16, not WAV/MP3/WebM container bytes.
  // Share the bounded ffmpeg decoder with Codex transcription for containers.
  let audio = file;
  if (!/^audio\/pcm(?:;|$)/i.test(mimeType)) audio = await convertAudio(file, abortSignal, { sampleRate: 16000, rawPcm: true });
  const audioMime = audio === file ? (mimeType.includes("rate=") ? mimeType : "audio/pcm;rate=16000") : "audio/pcm;rate=16000";
  const buf = Buffer.from(await audio.arrayBuffer());
  if (!buf.length) throw new GeminiLiveError("Empty audio file", 400);
  const rate = Number(/(?:^|;)rate=(\d+)/i.exec(audioMime)?.[1] || 16000);
  if (!Number.isFinite(rate) || rate < 8000 || rate > 48000 || buf.length % 2) throw new GeminiLiveError("Invalid PCM16 audio", 400);
  if (buf.length > MAX_AUDIO_SECONDS * rate * 2) throw new GeminiLiveError(`Audio duration exceeds ${MAX_AUDIO_SECONDS} seconds`, 400);
  if (abortSignal?.aborted) throw new GeminiLiveError("Gemini Live transcription aborted", 499);

  const instruction = firstStringField(formData, "prompt") || "Transcribe the spoken audio verbatim.";
  const language = firstStringField(formData, "language");
  const setupTimeoutMs = firstNumberField(formData, "setup_timeout_ms", SETUP_TIMEOUT_MS);
  const turnTimeoutMs = firstNumberField(formData, "turn_timeout_ms", TURN_TIMEOUT_MS);
  // system_instruction (registry param) overrides the built-in transcription
  // directive wholesale; prompt/language only shape the default.
  const instructionOverride = firstStringField(formData, "system_instruction");
  const systemText = instructionOverride
    || (language ? `${instruction} Language: ${language}.` : instruction);
  const wsUrl = toLiveWsUrl(cfg.baseUrl, token);

  return await new Promise((resolve, reject) => {
    let text = "";
    const chunks = [];        // raw inputTranscription deltas, shaped by sttCore
    let settled = false;
    let timer = null;
    let ws = null;
    let generation = 0;       // socket identity: superseded closes never settle
    let sentBytes = 0;        // audio prefix already handed to the live socket

    // Client abort settles the socket the same way a hard error does —
    // stt.js maps status 499 to its request-aborted lane.
    const onAbort = () => fail(new GeminiLiveError("Gemini Live transcription aborted", 499));
    if (abortSignal?.addEventListener) abortSignal.addEventListener("abort", onAbort, { once: true });

    const arm = (ms, message) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail(new GeminiLiveError(message, 504)), ms);
    };
    const shutdown = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (abortSignal?.removeEventListener) abortSignal.removeEventListener("abort", onAbort);
      // ws is null until the first open() dials (and stays null when the
      // constructor throws) — fail() runs shutdown() on that path.
      if (!ws) return;
      try {
        if (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING) ws.close(1000);
      } catch { /* socket already dead — outcome is already settled */ }
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      shutdown();
      resolve({ text, chunks });
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      shutdown();
      reject(err);
    };
    const send = (frame) => {
      if (ws.readyState !== WS.OPEN) return false;
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        return false; // socket died mid-send — streamAudioAndPrompt maps this to a 502
      }
      return true;
    };

    // Stream the PCM payload, then signal the end of audio.
    const streamAudioAndPrompt = () => {
      for (let off = sentBytes; off < buf.length; off += CHUNK_BYTES) {
        const mediaChunk = buf.subarray(off, off + CHUNK_BYTES).toString("base64");
        if (!send({ realtimeInput: { mediaChunks: [{ mimeType: audioMime, data: mediaChunk }] } })) {
          fail(new GeminiLiveError("Gemini Live socket closed while streaming audio", 502));
          return;
        }
        sentBytes = Math.min(off + CHUNK_BYTES, buf.length);
      }
      // Flush the realtime audio recognizer before closing this user turn.
      send({ realtimeInput: { audioStreamEnd: true } });
    };

    const open = () => {
      const gen = ++generation;
      try {
        // undici's WebSocket accepts { dispatcher } to honour the
        // per-connection egress proxy; minimal polyfills ignore the arg.
        ws = dispatcher ? new WS(wsUrl, { dispatcher }) : new WS(wsUrl);
        ws.binaryType = "arraybuffer";
      } catch {
        fail(new GeminiLiveError("Gemini Live websocket connection failed", 502));
        return;
      }
      bindSocket(ws, {
        onOpen: () => {
          if (settled || gen !== generation) return;
          arm(setupTimeoutMs, "Gemini Live timed out waiting for setupComplete");
          send({
            setup: {
              model: `models/${model}`,
              generationConfig: {
                responseModalities: ["AUDIO"],
              },
              inputAudioTranscription: {},
              systemInstruction: { parts: [{ text: systemText }] },
            },
          });
        },
        onMessage: (ev) => {
          if (settled || gen !== generation) return;
          const frame = parseFrame(ev?.data);
          if (!frame) return;

          if (frame.error) {
            const e = frame.error;
            fail(new GeminiLiveError(`Gemini Live error${e.status ? ` (${e.status})` : ""}: ${e.message || "unknown"}`, 502));
            return;
          }
          if (frame.goAway) {
            fail(new GeminiLiveError("Gemini Live session ended before transcription completed; retry transcription", 502));
            return;
          }

          if (frame.setupComplete) {
            arm(turnTimeoutMs, "Gemini Live transcription timed out");
            streamAudioAndPrompt();
            return;
          }

          const sc = frame.serverContent;
          if (!sc) return;

          const delta = typeof sc.inputTranscription?.text === "string" ? sc.inputTranscription.text : "";
          // Trim before testing: a padding-only frame carries no transcript and
          // must not make an empty run look like a partial success on close.
          if (delta.trim()) {
            text += delta;
            chunks.push(delta);
          }

          if (sc.turnComplete) succeed();
        },
        onError: () => {
          if (settled || gen !== generation) return;
          fail(new GeminiLiveError("Gemini Live websocket connection failed", 502));
        },
        onClose: (ev) => {
          if (settled || gen !== generation) return;
          // Partial transcript beats a hard error on graceful close; silence is one.
          if (text.trim()) succeed();
          else fail(new GeminiLiveError(`Gemini Live socket closed before completion${ev?.code ? ` (code ${ev.code})` : ""}`, 502));
        },
      });
    };

    open();
  });
}
