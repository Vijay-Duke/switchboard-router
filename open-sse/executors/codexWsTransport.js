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

  let streamDone = false;
  const onAbort = () => { try { ws.close(); } catch { /* already closed */ } };
  signal?.addEventListener?.("abort", onAbort, { once: true });

  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: "response.create", ...request }));
        dbg("CODEX-WS", `opened ${wsUrl} | request sent`);
        resolve();
      } catch (error) {
        reject(new Error(`codex ws send failed: ${error.message}`));
      }
    };
    ws.onerror = () => reject(new Error("codex ws handshake failed"));
  });

  const body = new ReadableStream({
    start(controller) {
      const finish = (error) => {
        if (streamDone) return;
        streamDone = true;
        signal?.removeEventListener?.("abort", onAbort);
        try { ws.close(); } catch { /* already closed */ }
        try {
          if (error) controller.error(error);
          else controller.close();
        } catch { /* downstream already closed */ }
      };

      ws.onmessage = (event) => {
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
      streamDone = true;
      signal?.removeEventListener?.("abort", onAbort);
      try { ws.close(); } catch { /* already closed */ }
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
