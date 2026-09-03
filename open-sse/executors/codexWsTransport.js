// Codex responses_websocket transport.
//
// The official Codex CLI streams ChatGPT-tier responses over a WebSocket
// (`transport="responses_websocket"`); OpenAI caps the legacy HTTP SSE path
// at 30s. One request = one text frame `{"type":"response.create",...}`;
// each server frame is one Responses API event JSON. This module bridges a
// WebSocket exchange into an SSE-encoded Response so the downstream
// translator, usage extraction, and terminal handling stay untouched.
import { FORMATS } from "../translator/formats.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { isOpenAIResponsesTerminalEvent } from "../utils/responsesStreamHelpers.js";
import { dbg } from "../utils/debugLog.js";

const encoder = new TextEncoder();

export function toWsUrl(httpUrl) {
  return String(httpUrl).replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
}

/**
 * Stream one Responses request over a WebSocket connection.
 *
 * @param {object} options
 * @param {string} options.wsUrl - wss:// endpoint (same path as HTTP /responses)
 * @param {object} options.headers - identity/auth headers for the upgrade request
 * @param {object} options.request - Responses API request body (stream:true)
 * @param {Function} [options.WebSocket] - injectable WebSocket class (tests)
 * @param {AbortSignal} [options.signal] - client abort
 * @param {object} [options.dispatcher] - undici dispatcher (per-connection proxy)
 * @param {number} [options.connectTimeoutMs] - reject `ready` if no frame arrives in time
 * @returns {{ response: Response, url: string, headers: object, ready: Promise<void> }}
 *   `response.body` is SSE bytes identical in shape to the HTTP transport.
 *   `ready` settles on the first frame (not on open): an early error frame
 *   rejects so the caller can fall back to HTTP instead of streaming a 200
 *   that only carries an error.
 */
export function streamResponsesOverWebSocket({ wsUrl, headers, request, WebSocket = globalThis.WebSocket, signal, dispatcher, connectTimeoutMs = FETCH_CONNECT_TIMEOUT_MS } = {}) {
  if (typeof WebSocket !== "function") {
    throw new Error("no WebSocket implementation available");
  }

  let ws;
  try {
    ws = new WebSocket(wsUrl, dispatcher ? { headers, dispatcher } : { headers });
  } catch (error) {
    throw new Error(`codex ws connect failed: ${error.message}`);
  }

  let controller = null;
  // Frames buffered while the downstream has no demand (backpressure). A
  // single response is bounded, but a slow client must not pin the whole
  // response in the stream queue under fan-out.
  const pending = [];
  let terminalReceived = false;
  let readySettled = false;
  let streamDone = false;
  let opened = false;
  let resolveReady;
  let rejectReady;

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const closeSocket = () => {
    try { ws.close(); } catch { /* already closed */ }
  };

  const finish = (error, closeStream = true) => {
    if (streamDone) return;
    streamDone = true;
    clearTimeout(readyTimer);
    signal?.removeEventListener?.("abort", onAbort);
    closeSocket();
    if (!readySettled) {
      readySettled = true;
      if (error) rejectReady(error);
      else resolveReady();
    }
    if (!closeStream || !controller) return;
    try {
      if (error) controller.error(error);
      else controller.close();
    } catch { /* downstream already closed */ }
  };

  const onAbort = () => finish(new DOMException("The operation was aborted.", "AbortError"));
  signal?.addEventListener?.("abort", onAbort, { once: true });

  // A stalled TCP/TLS connect or a server that never frames must reject
  // `ready` so the caller falls back to HTTP instead of hanging.
  const readyTimer = setTimeout(() => {
    finish(Object.assign(new Error("codex ws first frame timeout"), { code: "codex_ws_timeout", status: 504 }));
  }, connectTimeoutMs);
  readyTimer.unref?.();
  // An already-aborted signal never fires "abort"; settle now so the socket
  // does not connect and send on behalf of a client that has gone.
  if (signal?.aborted) onAbort();

  // Enqueue only while the downstream has demand; the rest waits in `pending`
  // for pull().
  const drain = () => {
    if (!controller || streamDone) return;
    while (pending.length > 0) {
      if (!(controller.desiredSize > 0)) break;
      try {
        controller.enqueue(pending.shift());
      } catch {
        break;
      }
    }
  };

  const maybeFinishTerminal = () => {
    if (terminalReceived && pending.length === 0) finish();
  };

  ws.onopen = () => {
    if (streamDone) return;
    try {
      ws.send(JSON.stringify({ type: "response.create", ...request }));
      opened = true;
      dbg("CODEX-WS", `opened ${wsUrl} | request sent`);
    } catch (error) {
      finish(new Error(`codex ws send failed: ${error.message}`));
    }
  };
  ws.onerror = () => finish(new Error(opened ? "codex ws transport failed" : "codex ws handshake failed"));

  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
      ws.onmessage = (event) => {
        if (streamDone) return;
        const raw = typeof event.data === "string" ? event.data : "";
        let frame = null;
        try { frame = JSON.parse(raw); } catch { /* non-JSON frame */ }
        const type = frame?.type || null;
        if (!type) return;
        if (!readySettled) {
          if (type === "error") {
            finish(Object.assign(
              new Error(frame?.error?.message || "codex ws error frame"),
              { status: Number(frame?.status) || 502, code: "codex_ws_error_frame" },
            ));
            return;
          }
          readySettled = true;
          clearTimeout(readyTimer);
          resolveReady();
        }
        pending.push(encoder.encode(`event: ${type}\ndata: ${raw}\n\n`));
        if (isOpenAIResponsesTerminalEvent(type, { response: {} })) {
          dbg("CODEX-WS", `terminal ${type} | closing`);
          terminalReceived = true;
        }
        drain();
        maybeFinishTerminal();
      };
      ws.onclose = () => {
        if (streamDone) return;
        if (terminalReceived) {
          // Terminal frame arrived but the downstream never drained: flush the
          // bounded remainder so the complete response is not lost, then close.
          try {
            while (pending.length > 0) controller.enqueue(pending.shift());
          } catch { /* downstream already closed */ }
          finish();
          return;
        }
        finish(new Error("codex ws closed before terminal event"));
      };
    },
    pull() {
      drain();
      maybeFinishTerminal();
    },
    cancel() {
      finish(null, false);
    },
  });

  return {
    response: new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Switchboard-Transport": "responses-websocket",
      },
    }),
    url: wsUrl,
    headers,
    ready,
    format: FORMATS.OPENAI_RESPONSES,
  };
}
