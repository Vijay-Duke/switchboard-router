// Codex responses_websocket transport.
//
// The official Codex CLI streams ChatGPT-tier responses over a WebSocket
// (`transport="responses_websocket"`); OpenAI caps the legacy HTTP SSE path
// at 30s. One request = one text frame `{"type":"response.create",...}`;
// each server frame is one Responses API event JSON. This module bridges a
// WebSocket exchange into an SSE-encoded Response so the downstream
// translator, usage extraction, and terminal handling stay untouched.
import { FORMATS } from "../translator/formats.js";
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
 * @returns {{ response: Response, url: string, headers: object, ready: Promise<void> }}
 *   `response.body` is SSE bytes identical in shape to the HTTP transport.
 */
export function streamResponsesOverWebSocket({ wsUrl, headers, request, WebSocket = globalThis.WebSocket, signal } = {}) {
  if (typeof WebSocket !== "function") {
    throw new Error("no WebSocket implementation available");
  }

  let ws;
  try {
    ws = new WebSocket(wsUrl, { headers });
  } catch (error) {
    throw new Error(`codex ws connect failed: ${error.message}`);
  }

  let controller = null;
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

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify({ type: "response.create", ...request }));
      opened = true;
      readySettled = true;
      dbg("CODEX-WS", `opened ${wsUrl} | request sent`);
      resolveReady();
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
        let type = null;
        try { type = JSON.parse(raw)?.type || null; } catch { /* non-JSON frame */ }
        if (!type) return;
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${raw}\n\n`));
        if (isOpenAIResponsesTerminalEvent(type, { response: {} })) {
          dbg("CODEX-WS", `terminal ${type} | closing`);
          finish();
        }
      };
      ws.onclose = () => finish(streamDone ? null : new Error("codex ws closed before terminal event"));
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
