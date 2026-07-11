/**
 * Worker response acceptance and protocol inspection for Auto routing.
 * Kept independent from routing policy so streaming semantics can evolve safely.
 */

/** Idle silence before treating a stream as empty (reset whenever bytes arrive). */
export const STREAM_PROBE_IDLE_MS = 20_000;

/**
 * Accept a 2xx worker response for dispatch.
 * - Stream: first non-keepalive non-error event — idle timeout only.
 * - Non-stream: reject empty JSON completions; unparseable bodies pass through.
 * @param {Response} result
 * @param {object} [log]
 * @param {{ abortSignal?: AbortSignal|null }} [opts]
 * @returns {Promise<{ ok: boolean, result?: Response, preInspect?: object, reason?: string }>}
 */
export async function acceptWorkerResponse(result, log, opts = {}) {
  if (!result?.ok) {
    return { ok: false, reason: "http_error" };
  }

  const ct = (result.headers?.get?.("content-type") || "").toLowerCase();
  const isStream = ct.includes("text/event-stream") || ct.includes("ndjson");

  if (!isStream || !result.body) {
    // Non-streaming: reject empty completions only; unparseable → pass through
    try {
      const data = await result.clone().json();
      const usage = extractUsage(data);
      const tokensIn = usage?.prompt_tokens ?? null;
      const tokensOut = usage?.completion_tokens ?? null;
      const hasCompletion =
        hasJsonCompletion(data) ||
        (typeof tokensOut === "number" && tokensOut > 0);
      if (!hasCompletion) {
        try {
          await result.body?.cancel?.();
        } catch {
          /* ignore */
        }
        return { ok: false, reason: "empty_json" };
      }
      return {
        ok: true,
        result,
        preInspect: { hasCompletion: true, tokensIn, tokensOut, data },
      };
    } catch {
      // text/plain or already-consumed body — do not burn the fallback chain
      return {
        ok: true,
        result,
        preInspect: { hasCompletion: false, tokensIn: null, tokensOut: null },
      };
    }
  }

  // Streaming: first non-keepalive non-error event; idle silence fails
  const probed = await probeStreamForContent(result.body, STREAM_PROBE_IDLE_MS, {
    abortSignal: opts.abortSignal || null,
  });
  if (!probed.accepted) {
    log?.warn?.("AUTO", `empty stream after probe (${probed.reason || "no_content"})`);
    return { ok: false, reason: probed.reason || "empty_stream" };
  }

  const restreamed = restreamFromProbe(probed);
  const out = new Response(restreamed, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  return {
    ok: true,
    result: out,
    preInspect: {
      // Only true if first event already carried text/tools; else observer decides
      hasCompletion: !!probed.sawCompletion,
      tokensIn: probed.tokensIn,
      tokensOut: probed.tokensOut,
    },
  };
}

/**
 * Read upstream until first non-keepalive event, stream end, or idle timeout.
 * Idle deadline resets on every non-empty chunk (thinking models stay alive).
 * On accept, leaves reader open for restreamFromProbe (unless already ended).
 *
 * @param {ReadableStream} body
 * @param {number} [idleMs] silence budget (default STREAM_PROBE_IDLE_MS)
 * @returns {Promise<{ accepted: boolean, hasContent?: boolean, reason?: string, prefixChunks: Uint8Array[], reader: ReadableStreamDefaultReader|null, ended?: boolean, sawCompletion?: boolean, tokensIn?: number|null, tokensOut?: number|null }>}
 */
export async function probeStreamForContent(
  body,
  idleMs = STREAM_PROBE_IDLE_MS,
  opts = {}
) {
  if (!body || typeof body.getReader !== "function") {
    return {
      accepted: false,
      hasContent: false,
      reason: "no_body",
      prefixChunks: [],
      reader: null,
    };
  }

  const abortSignal = opts.abortSignal || null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  /** @type {Uint8Array[]} */
  const prefixChunks = [];
  let tokensIn = null;
  let tokensOut = null;
  let sawCompletion = false;
  /** Rolling tail for split-line keepalive / content detection (fresh slice + overlap). */
  let tail = "";
  // No hard floor — callers pass STREAM_PROBE_IDLE_MS (20s); tests use short budgets
  const idleBudget = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : STREAM_PROBE_IDLE_MS;
  let idleDeadline = Date.now() + idleBudget;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {(() => void)|null} */
  let onAbort = null;

  const clearTimer = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const cleanupAbort = () => {
    if (onAbort && abortSignal) {
      try {
        abortSignal.removeEventListener("abort", onAbort);
      } catch {
        /* ignore */
      }
      onAbort = null;
    }
  };

  const finishEmpty = async (reason) => {
    clearTimer();
    cleanupAbort();
    try {
      await reader.cancel(reason || "empty_stream");
    } catch {
      /* ignore */
    }
    return {
      accepted: false,
      hasContent: false,
      reason,
      prefixChunks,
      reader: null,
      tokensIn,
      tokensOut,
      sawCompletion: false,
    };
  };

  const accept = (ended) => {
    clearTimer();
    cleanupAbort();
    return {
      accepted: true,
      hasContent: true,
      prefixChunks,
      reader: ended ? null : reader,
      ended: !!ended,
      tokensIn,
      tokensOut,
      sawCompletion,
    };
  };

  try {
    while (true) {
      if (abortSignal?.aborted) {
        return finishEmpty("client_aborted");
      }

      const remaining = idleDeadline - Date.now();
      if (remaining <= 0) {
        return finishEmpty("probe_idle_timeout");
      }

      const readPromise = reader.read().then((r) => ({ kind: "read", r }));
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
      });
      const abortPromise = abortSignal
        ? new Promise((resolve) => {
            onAbort = () => resolve({ kind: "aborted" });
            if (abortSignal.aborted) {
              onAbort();
            } else {
              abortSignal.addEventListener("abort", onAbort, { once: true });
            }
          })
        : null;

      const chunk = await Promise.race(
        [readPromise, timeoutPromise, abortPromise].filter(Boolean)
      );
      clearTimer();
      if (chunk.kind !== "aborted") cleanupAbort();

      if (chunk.kind === "timeout") {
        return finishEmpty("probe_idle_timeout");
      }
      if (chunk.kind === "aborted") {
        return finishEmpty("client_aborted");
      }

      const { done, value } = chunk.r;
      if (done) {
        // Never saw a non-keepalive non-error event → empty (or error-only stream)
        clearTimer();
        cleanupAbort();
        return {
          accepted: false,
          hasContent: false,
          reason: "empty_stream_end",
          prefixChunks,
          reader: null,
          ended: true,
          tokensIn,
          tokensOut,
          sawCompletion: false,
        };
      }

      if (value?.byteLength) {
        // Any bytes = alive stream → reset idle deadline (thinking models stay alive)
        idleDeadline = Date.now() + idleBudget;
        prefixChunks.push(value);

        const fresh = decoder.decode(value, { stream: true });
        // Fresh slice + small overlap for lines split across chunks
        const freshWindow = tail.slice(-64) + fresh;
        tail = (tail + fresh).slice(-512);

        if (chunkHasCompletion(freshWindow)) sawCompletion = true;
        const usage = extractUsageFromSseSlice(freshWindow);
        if (usage) {
          tokensIn = usage.prompt_tokens ?? tokensIn;
          tokensOut = usage.completion_tokens ?? tokensOut;
          if (tokensOut > 0) sawCompletion = true;
        }

        // Keepalive-only (: ping, empty) — keep probing without committing
        if (isSseKeepaliveText(fresh)) continue;

        // SSE error frames: do not commit to client; keep waiting → empty_stream_end / fallback
        if (freshWindowHasSseError(freshWindow)) continue;

        // First non-keepalive activity → accept (message_start, thinking, content, tools…)
        return accept(false);
      } else if (value) {
        prefixChunks.push(value);
      }
    }
  } catch (e) {
    clearTimer();
    cleanupAbort();
    try {
      await reader.cancel(e?.message || "probe_error");
    } catch {
      /* ignore */
    }
    return {
      accepted: false,
      hasContent: false,
      reason: "probe_error",
      prefixChunks,
      reader: null,
      tokensIn,
      tokensOut,
      sawCompletion: false,
    };
  }
}

/**
 * Rebuild a ReadableStream from probe prefix + remaining reader.
 * Cancel propagates to the upstream reader.
 * @param {{ prefixChunks: Uint8Array[], reader: ReadableStreamDefaultReader|null, ended?: boolean }} probed
 */
export function restreamFromProbe(probed) {
  const prefix = probed.prefixChunks || [];
  let idx = 0;
  const reader = probed.reader;
  const ended = !!probed.ended || !reader;

  return new ReadableStream({
    async pull(ctrl) {
      try {
        if (idx < prefix.length) {
          ctrl.enqueue(prefix[idx++]);
          return;
        }
        if (ended || !reader) {
          ctrl.close();
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          ctrl.close();
          return;
        }
        if (value) ctrl.enqueue(value);
      } catch (e) {
        try {
          ctrl.error(e);
        } catch {
          /* ignore */
        }
      }
    },
    async cancel(reason) {
      if (reader) {
        try {
          await reader.cancel(reason);
        } catch {
          /* ignore */
        }
      }
    },
  });
}

/**
 * Wrap upstream stream: forward chunks to client, observe for scoring, and
 * propagate cancel() to the source so disconnect aborts the provider request.
 * (No tee — tee swallows cancel while the observer branch stays open.)
 */


/**
 * Extract assistant text from OpenAI / Claude / Gemini Response.
 * Consumes the response body (no orphaned tee branch).
 * @returns {Promise<{ text: string, httpError?: string, status?: number }>}
 */
export async function extractAssistantText(response) {
  if (!response) return { text: "", httpError: "router_http_0", status: 0 };

  const status = response.status ?? 0;
  if (!response.ok) {
    // Drain body so the connection can close
    try {
      await response.text();
    } catch {
      /* ignore */
    }
    return {
      text: "",
      httpError: `router_http_${status}`,
      status,
    };
  }

  const ct = (response.headers?.get?.("content-type") || "").toLowerCase();
  try {
    // Consume original body (not a clone) so undici doesn't buffer an unread tee
    if (ct.includes("text/event-stream") || ct.includes("ndjson")) {
      const raw = await response.text();
      return { text: textFromSse(raw), status };
    }
    const raw = await response.text();
    try {
      return { text: assistantTextFromJson(JSON.parse(raw)), status };
    } catch {
      if (raw.includes("data:")) return { text: textFromSse(raw), status };
      return { text: raw, status };
    }
  } catch {
    return { text: "", status };
  }
}

function assistantTextFromJson(data) {
  if (!data || typeof data !== "object") return "";
  const choice = data?.choices?.[0];
  if (choice?.message?.content) {
    const c = choice.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b) => b?.text || b?.content || "").join("");
  }
  if (typeof choice?.text === "string") return choice.text;
  if (Array.isArray(data?.content)) {
    return data.content.map((b) => b?.text || "").join("");
  }
  if (typeof data?.content === "string") return data.content;
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text || "").join("");
  // Responses API output
  if (Array.isArray(data?.output)) {
    const texts = [];
    for (const item of data.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && c.text) texts.push(c.text);
          else if (typeof c?.text === "string") texts.push(c.text);
        }
      }
    }
    if (texts.length) return texts.join("");
  }
  return "";
}

function textFromSse(rawSSE) {
  const parts = [];
  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      // OpenAI chat completions SSE
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") parts.push(delta);
      const msg = chunk?.choices?.[0]?.message?.content;
      if (typeof msg === "string") parts.push(msg);
      // Claude SSE
      if (chunk?.type === "content_block_delta" && chunk?.delta?.text) {
        parts.push(chunk.delta.text);
      }
      if (chunk?.delta?.type === "text_delta" && chunk?.delta?.text) {
        parts.push(chunk.delta.text);
      }
      // Gemini SSE
      const gParts = chunk?.candidates?.[0]?.content?.parts;
      if (Array.isArray(gParts)) {
        for (const p of gParts) {
          if (typeof p?.text === "string") parts.push(p.text);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return parts.join("");
}

/**
 * SSE comment / ping-only chunks — not enough to accept a worker during probe.
 * Exported for unit tests.
 */
export function isSseKeepaliveText(text) {
  const s = String(text || "");
  if (!s.trim()) return true;
  let sawAnything = false;
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    sawAnything = true;
    if (t.startsWith(":")) continue; // SSE comment / ": ping"
    if (/^event:\s*(ping|heartbeat)\s*$/i.test(t)) continue;
    if (t.startsWith("id:") || t.startsWith("retry:")) continue;
    if (t.startsWith("data:")) {
      const payload = t.slice(5).trim();
      // Empty data / stream terminator alone is not "the model is producing"
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        if (j && (j.type === "ping" || j.type === "heartbeat")) continue;
      } catch {
        /* non-JSON data is real activity */
      }
      return false;
    }
    return false;
  }
  return sawAnything || !s.trim();
}

function isErrorSsePayload(chunk) {
  if (!chunk || typeof chunk !== "object") return false;
  if (chunk.error) return true;
  if (chunk.type === "error") return true;
  if (chunk.choices?.[0]?.error) return true;
  return false;
}

/** True if any data: line in the window is an SSE error payload (probe must not accept). */
export function freshWindowHasSseError(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      if (isErrorSsePayload(JSON.parse(payload))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Detect non-empty *completion* for scoring (+10) — text OR tool/function calls.
 * Parses data: lines only; ignores error payloads (no false-positive on rate-limit text).
 * Does not count pure thinking as completion (observe still scores after content).
 */
export function hasStreamContent(buf) {
  return chunkHasCompletion(buf);
}

/** True when a data: payload carries user-visible or tool output (not errors, not thinking-only). */
export function chunkHasCompletion(buf) {
  if (!buf || buf.length < 4) return false;
  for (const line of String(buf).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (isErrorSsePayload(chunk)) continue;

      // OpenAI chat completions
      const delta = chunk?.choices?.[0]?.delta;
      if (typeof delta?.content === "string" && delta.content.length > 0) return true;
      if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) return true;
      if (delta?.function_call && (delta.function_call.name || delta.function_call.arguments)) {
        return true;
      }
      const msg = chunk?.choices?.[0]?.message;
      if (typeof msg?.content === "string" && msg.content.length > 0) return true;
      if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) return true;

      // OpenAI Responses API
      if (
        chunk?.type === "response.output_text.delta" ||
        chunk?.type === "response.function_call_arguments.delta"
      ) {
        return true;
      }
      if (typeof chunk?.delta === "string" && chunk.delta.length > 0 && chunk.type?.includes("output")) {
        return true;
      }

      // Claude content / tools (not thinking_delta alone)
      if (chunk?.type === "content_block_delta") {
        if (chunk?.delta?.type === "text_delta" && chunk?.delta?.text) return true;
        if (chunk?.delta?.type === "input_json_delta") return true;
        if (typeof chunk?.delta?.partial_json === "string") return true;
        if (typeof chunk?.delta?.text === "string" && chunk.delta.text && chunk.delta.type !== "thinking_delta") {
          return true;
        }
      }
      // tool_use block start is real work; bare text block start is often empty placeholder
      if (chunk?.type === "content_block_start") {
        if (chunk?.content_block?.type === "tool_use") return true;
        if (
          chunk?.content_block?.type === "text" &&
          typeof chunk.content_block.text === "string" &&
          chunk.content_block.text.length > 0
        ) {
          return true;
        }
      }

      // Gemini: non-thought text or functionCall
      const gParts = chunk?.candidates?.[0]?.content?.parts;
      if (Array.isArray(gParts)) {
        for (const p of gParts) {
          if (p?.functionCall) return true;
          if (typeof p?.text === "string" && p.text.length > 0 && p.thought !== true) return true;
        }
      }
    } catch {
      /* ignore non-JSON data lines for completion scoring */
    }
  }
  return false;
}

/**
 * Lightweight usage parse over a small fresh window (not the full 256KB buffer).
 */
export function extractUsageFromSseSlice(slice) {
  if (!slice || slice.length < 8) return null;
  // Reuse full extractor on a bounded window only
  return extractUsageFromSse(slice.length > 8000 ? slice.slice(-8000) : slice);
}

/** Non-stream completion: text and/or tool/function calls. */
export function hasJsonCompletion(data) {
  if (!data || typeof data !== "object") return false;
  if (assistantTextFromJson(data).length > 0) return true;
  const choice = data?.choices?.[0];
  const msg = choice?.message;
  if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) return true;
  if (msg?.function_call && (msg.function_call.name || msg.function_call.arguments)) {
    return true;
  }
  // Claude content blocks
  if (Array.isArray(data?.content)) {
    if (data.content.some((b) => b?.type === "tool_use" || b?.type === "function")) {
      return true;
    }
  }
  // Responses API
  if (Array.isArray(data?.output)) {
    if (
      data.output.some(
        (i) =>
          i?.type === "function_call" ||
          i?.type === "tool_call" ||
          i?.type === "custom_tool_call"
      )
    ) {
      return true;
    }
  }
  // Gemini
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.some((p) => p?.functionCall)) return true;
  return false;
}

export function extractUsage(data) {
  if (!data || typeof data !== "object") return null;
  if (data.usage?.prompt_tokens != null || data.usage?.completion_tokens != null) {
    return {
      prompt_tokens: data.usage.prompt_tokens ?? 0,
      completion_tokens: data.usage.completion_tokens ?? 0,
    };
  }
  if (data.usage?.input_tokens != null || data.usage?.output_tokens != null) {
    return {
      prompt_tokens: data.usage.input_tokens ?? 0,
      completion_tokens: data.usage.output_tokens ?? 0,
    };
  }
  if (data.usageMetadata) {
    return {
      prompt_tokens: data.usageMetadata.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata.candidatesTokenCount ?? 0,
    };
  }
  return null;
}

function extractUsageFromSse(raw) {
  let last = null;
  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      const u = extractUsage(chunk);
      if (u) last = u;
      // Claude message_delta usage
      if (chunk?.usage) {
        last = {
          prompt_tokens: chunk.usage.input_tokens ?? last?.prompt_tokens ?? 0,
          completion_tokens: chunk.usage.output_tokens ?? last?.completion_tokens ?? 0,
        };
      }
      if (chunk?.message?.usage) {
        last = {
          prompt_tokens: chunk.message.usage.input_tokens ?? 0,
          completion_tokens: chunk.message.usage.output_tokens ?? 0,
        };
      }
    } catch {
      /* ignore */
    }
  }
  return last;
}
