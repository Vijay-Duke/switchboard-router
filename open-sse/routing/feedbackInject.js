import { ASK_LINE } from "./feedbackAsk.js";

// Body length/encoding change when the ask line is appended — a stale upstream
// Content-Length would truncate the response at the client.
function headersWithoutLength(headers) {
  const h = new Headers(headers);
  h.delete("content-length");
  h.delete("content-encoding");
  return h;
}

/**
 * Append a feedback ask to a non-streaming OpenAI chat-completions response.
 * All failures preserve the original response exactly.
 */
export async function appendAskToOpenAiJson(response, askText = ASK_LINE) {
  try {
    const body = await response.clone().text();
    const json = JSON.parse(body);
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return response;

    json.choices[0].message.content = content + askText;
    return new Response(JSON.stringify(json), {
      status: response.status,
      statusText: response.statusText,
      headers: headersWithoutLength(response.headers),
    });
  } catch {
    return response;
  }
}

/**
 * Inject a feedback ask into an OpenAI SSE response.
 * All stream failures close quietly so feedback cannot corrupt the client response.
 */
export function injectAskIntoOpenAiStream(response, askText = ASK_LINE) {
  try {
    if (!response?.body || typeof response.body.getReader !== "function") return response;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let closed = false;
    let injected = false;

    const askChunk = () => ({
      id: "chatcmpl-fbask",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "auto",
      choices: [{ index: 0, delta: { content: askText }, finish_reason: null }],
    });

    const enqueueAsk = (controller) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(askChunk())}\n\n`));
      injected = true;
    };

    const enqueueLine = (controller, line) => {
      if (line.trim() === "data: [DONE]") return;

      if (line.startsWith("data: ") && !injected) {
        try {
          const chunk = JSON.parse(line.slice("data: ".length));
          if (chunk?.choices?.[0]?.finish_reason != null) enqueueAsk(controller);
        } catch {
          /* fail-open: forward malformed or non-JSON data unchanged */
        }
      }
      controller.enqueue(encoder.encode(`${line}\n`));
    };

    const enqueueCompleteLines = (controller) => {
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        enqueueLine(controller, line);
        newline = buffer.indexOf("\n");
      }
    };

    const closeWithAsk = (controller) => {
      if (closed) return;
      closed = true;
      try {
        buffer += decoder.decode();
        enqueueCompleteLines(controller);
        if (buffer) {
          enqueueLine(controller, buffer);
          buffer = "";
        }
        // Standard order (content → finish_reason → [DONE]) is guaranteed when a
        // finish chunk exists; providers without one use this on-done fallback.
        if (!injected) enqueueAsk(controller);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch {
        /* fail-open */
      }
      try {
        controller.close();
      } catch {
        /* fail-open */
      }
    };

    const stream = new ReadableStream({
      async pull(controller) {
        if (closed) return;
        try {
          const { done, value } = await reader.read();
          if (done) {
            closeWithAsk(controller);
            return;
          }
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            enqueueCompleteLines(controller);
          }
        } catch {
          closed = true;
          try {
            controller.close();
          } catch {
            /* fail-open */
          }
        }
      },
      async cancel(reason) {
        closed = true;
        try {
          await reader.cancel(reason);
        } catch {
          /* fail-open */
        }
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: headersWithoutLength(response.headers),
    });
  } catch {
    return response;
  }
}
