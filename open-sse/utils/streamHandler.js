// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS, STREAM_FIRST_CHUNK_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";
import { nextTag, tagForSession, line, errorLine } from "./logTags.js";

// Terminal SSE markers. A clean upstream EOF that forwarded bytes without any
// of these is a truncated stream (overloaded provider sent a partial chunk then
// reset), not a completion — synthesize a stall terminal so clients get a finish.
const TERMINAL_PATTERN = /data:\s*\[DONE\]|"finish_reason"\s*:\s*"[^"\\]+"|"type"\s*:\s*"(?:message_stop|error|response\.(?:completed|done|failed|incomplete))"/;

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance (log.line/log.errorLine preferred when present)
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 * @param {string} [options.reqTag] - Pre-allocated lifecycle tag; one is allocated per controller when absent
 * @param {string} [options.sessionSeed] - Stable session key; maps to a fixed color tag
 */
export function createStreamController({ onDisconnect, onError, log, provider, model, reqTag = "", sessionSeed = "" } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  // One tag per request: every lifecycle line of this controller shares it.
  // Host logger emitters win when available so caller-side level filtering applies.
  const tag = reqTag || (sessionSeed ? tagForSession(sessionSeed) : nextTag());
  const logStream = (symbol, status, isError = false, tail = "") => {
    const duration = Date.now() - startTime;
    const emit = isError ? (log?.errorLine ?? errorLine) : (log?.line ?? line);
    emit(tag, symbol, `${status} · ${provider}/${model} · ${duration}ms${tail}`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      logStream("⚡", `DISCONNECT: ${reason}`);
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      logStream("🌊", "COMPLETE");

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return;
      }

      logStream("✗", `ERROR: ${error.message}`, true, error.stack ? `\n    ${error.stack}` : "");
      onError?.(error);
    },

    abort: () => abortController.abort()
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 */
export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null, onStreamFailure = null) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  let terminalEmitted = false;
  let finishSeen = false;
  let bytesForwarded = 0;
  let tail = "";
  const decoder = new TextDecoder();
  let pendingRead;
  const abortRead = () => {
    // Persist cancellation even if the downstream is no longer reading. It
    // must not leave a request pending until the next pull happens to arrive.
    const error = streamController.signal?.reason || new Error("stream aborted before completion");
    onStreamFailure?.(error);
    if (streamController.isConnected()) streamController.handleError?.(error);
    pendingRead?.({ aborted: true });
    cancelUpstream();
  };
  streamController.signal?.addEventListener("abort", abortRead, { once: true });
  const cleanup = () => streamController.signal?.removeEventListener("abort", abortRead);
  const read = () => new Promise((resolve, reject) => {
    pendingRead = resolve;
    if (streamController.signal?.aborted) abortRead();
    else reader.read().then(resolve, reject);
  }).finally(() => { pendingRead = null; });
  const cancelUpstream = () => {
    // Cleanup must never block delivery of the terminal error to the client.
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
  };

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch { /* best-effort terminal */ }
  };

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected()) {
        cleanup();
        onStreamFailure?.(new Error("stream interrupted before completion"));
        streamController.handleDisconnect?.("stream interrupted before completion");
        cancelUpstream();
        emitTerminal(controller);
        controller.close();
        return;
      }

      try {
        const result = await read();
        if (result.aborted) throw streamController.signal?.reason || new DOMException("aborted", "AbortError");
        const { done, value } = result;

        if (done) {
          cleanup();
          // Upstream closed after sending bytes but never emitted a terminal
          // finish (e.g. an overloaded provider sending a partial chunk then
          // resetting). Without a synthesized terminal, clients (pi) see a
          // truncated turn. Emit the stall terminal so they get a clean
          // finish_reason + [DONE] instead. Only fires where onAbortTerminal
          // exists (chat-completions wire / Responses passthrough).
          if (bytesForwarded > 0 && !finishSeen) {
            const error = new Error("upstream closed before stream completion");
            onStreamFailure?.(error);
            streamController.handleError(error);
            emitTerminal(controller);
          } else streamController.handleComplete();
          controller.close();
          return;
        }
        controller.enqueue(value);
        bytesForwarded += value instanceof Uint8Array ? value.byteLength : 0;
        if (!finishSeen) {
          const window = tail + decoder.decode(value, { stream: true });
          // A null finish_reason is present on normal deltas and is not terminal.
          if (TERMINAL_PATTERN.test(window)) finishSeen = true;
          tail = window.length > 128 ? window.slice(-128) : window;
        }
      } catch (error) {
        cleanup();
        onStreamFailure?.(error);
        const wasConnected = streamController.isConnected();
        // Controller already closed = downstream ended; not an upstream error, skip noisy log.
        const msg0 = error?.message || "";
        const isControllerClosed = msg0.includes("already closed") || msg0.includes("Invalid state");
        if (!isControllerClosed && wasConnected) streamController.handleError(error);
        cancelUpstream();

        // Treat network resets / socket hang up / abort as graceful close
        const msg = error?.message || "";
        const code = error?.code || error?.cause?.code || "";
        const isNetworkClose =
          error.name === "AbortError" ||
          msg.includes("aborted") ||
          msg.includes("socket hang up") ||
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("EPIPE") ||
          code === "ECONNRESET" ||
          code === "ETIMEDOUT" ||
          code === "EPIPE" ||
          code === "UND_ERR_SOCKET";

        // Graceful close on network/abort, or when a structured terminal is available
        // (Responses passthrough prefers response.failed + [DONE] over a raw transport error)
        try {
          if (!wasConnected || isNetworkClose || onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) { /* already closed or cancelled */ }
      }
    },

    cancel(reason) {
      cleanup();
      onStreamFailure?.(new Error("client disconnected before stream completion"));
      streamController.handleDisconnect(reason || "cancelled");
      // Floating these promises surfaces unhandled rejections when the other
      // end already settled — swallow like every sibling path in this file.
      try { reader.cancel()?.catch?.(() => {}); } catch { /* already closed */ }
      try { writer.abort()?.catch?.(() => {}); } catch { /* already closed */ }
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk refreshes the last-activity timestamp checked by a
 * single interval. If no bytes arrive for STREAM_STALL_TIMEOUT_MS, abort
 * the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(
  providerResponse,
  transformStream,
  streamController,
  onAbortTerminal = null,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
  firstChunkTimeoutMs = STREAM_FIRST_CHUNK_TIMEOUT_MS,
  onStreamFailure = null,
  progressWatchdog = null
) {
  // Own the client read deadline even when an upstream adapter ignores abort.
  const pipeAbort = new AbortController();
  let failureReported = false;
  const reportFailure = error => {
    if (failureReported) return;
    failureReported = true;
    onStreamFailure?.(error);
  };
  let stallInterval = null;
  let firstChunkTimer = null;
  let progressInterval = null;
  let progressSeen = false;
  let lastProgressAt = Date.now();
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  const t0 = Date.now();
  const tag = "STREAM";
  const clearStall = () => {
    if (stallInterval) { clearInterval(stallInterval); stallInterval = null; }
  };
  const clearFirstChunk = () => {
    if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = null; }
  };
  const clearProgress = () => {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    if (progressWatchdog) progressWatchdog.record = null;
  };
  const clearAllTimers = () => { clearStall(); clearFirstChunk(); clearProgress(); };
  // One interval per stream: transform only refreshes lastChunkAt, so hot
  // chunks cost no timer ops. The interval disarms itself when it fires.
  const armStall = () => {
    if (stallInterval || !(stallTimeoutMs > 0)) return;
    stallInterval = setInterval(() => {
      if (Date.now() - lastChunkAt >= stallTimeoutMs) {
        const fired = stallInterval;
        stallInterval = null;
        if (fired) clearInterval(fired);
        dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
        wrappedController.handleError(new Error("stream stall timeout"));
        wrappedController.abort();
      }
    }, Math.min(stallTimeoutMs, 5000));
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal ? AbortSignal.any([streamController.signal, pipeAbort.signal]) : pipeAbort.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => { dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearAllTimers(); streamController.handleComplete(); },
    handleError: (e) => { dbg(tag, `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearAllTimers(); reportFailure(e); streamController.handleError(e); pipeAbort.abort(e); },
    handleDisconnect: (r) => { dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearAllTimers(); streamController.handleDisconnect(r); },
    abort: () => { clearAllTimers(); pipeAbort.abort(); streamController.abort(); }
  };

  if (progressWatchdog) {
    const firstTimeout = progressWatchdog.firstProgressTimeoutMs;
    const progressTimeout = progressWatchdog.stallTimeoutMs;
    progressWatchdog.record = type => {
      if (type === "message_stop" || type === "error") return clearProgress();
      if (!["content_block_start", "content_block_delta", "content_block_stop", "message_delta"].includes(type)) return;
      progressSeen = true;
      lastProgressAt = Date.now();
    };
    const intervals = [firstTimeout, progressTimeout, 5000].filter(value => value > 0);
    progressInterval = setInterval(() => {
      const timeout = progressSeen ? progressTimeout : firstTimeout;
      if (timeout > 0 && Date.now() - lastProgressAt >= timeout) {
        wrappedController.handleError(new Error(progressSeen ? "stream model progress timeout" : "stream first model progress timeout"));
        wrappedController.abort();
      }
    }, Math.min(...intervals));
  }

  // M4: separate first-byte timer (prefill) vs inter-chunk stall
  if (firstChunkTimeoutMs > 0) {
    firstChunkTimer = setTimeout(() => {
      firstChunkTimer = null;
      if (chunkCount === 0) {
        dbg(tag, `FIRST-CHUNK TIMEOUT ${firstChunkTimeoutMs}ms`);
        wrappedController.handleError(new Error("stream first-chunk timeout"));
        wrappedController.abort();
      }
    }, firstChunkTimeoutMs);
  }
  dbg(tag, `pipe start | firstChunkTimeout=${firstChunkTimeoutMs}ms | stallTimeout=${stallTimeoutMs}ms`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      if (chunkCount === 1) {
        clearFirstChunk();
        armStall(); // arm inter-chunk stall only after first byte
      }
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      controller.enqueue(chunk);
    },
    flush() { dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearAllTimers(); }
  });

  // A streaming response without a body is an upstream protocol failure, not
  // a successful empty completion. Surface it through the stream so callers
  // can record the failure and apply their normal retry/fallback policy.
  if (!providerResponse?.body) {
    const providerBody = new ReadableStream({
      start(controller) {
        controller.error(new Error("upstream response missing body"));
      },
    });
    return createDisconnectAwareStream(
      { readable: providerBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
      wrappedController,
      onAbortTerminal,
      reportFailure
    );
  }
  const providerBody = providerResponse.body;
  const transformedBody = providerBody
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream);

  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    wrappedController,
    onAbortTerminal,
    reportFailure
  );
}
