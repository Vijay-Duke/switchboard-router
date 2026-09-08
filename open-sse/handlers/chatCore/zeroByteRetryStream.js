import { STREAM_FIRST_CHUNK_TIMEOUT_MS } from "../../config/runtimeConfig.js";

/**
 * One in-stream re-hit when upstream sent zero bytes (first-chunk timeout or
 * empty EOF). After any byte, replay is unsafe — caller emits the stall
 * terminal instead.
 */
export function createZeroByteRetryStream({
  body,
  reexecute,
  signal,
  firstChunkTimeoutMs = STREAM_FIRST_CHUNK_TIMEOUT_MS,
  log,
}) {
  let reader = body.getReader();
  let gotByte = false;
  let retried = false;
  let cancelled = false;
  let timer = null;
  let abortWaiter = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const fail = (controller) => {
    try { controller.error(new Error("stream first-chunk timeout")); } catch { /* closed */ }
  };

  const onAbort = () => abortWaiter?.();

  signal?.addEventListener?.("abort", onAbort);

  const cleanup = () => {
    clearTimer();
    signal?.removeEventListener?.("abort", onAbort);
  };

  return new ReadableStream({
    async pull(controller) {
      if (cancelled) {
        cleanup();
        controller.close();
        return;
      }
      if (signal?.aborted) {
        cleanup();
        if (gotByte) return fail(controller);
        controller.close();
        return;
      }
      try {
        while (true) {
          const timeoutP = !gotByte && firstChunkTimeoutMs > 0
            ? new Promise((resolve) => {
              timer = setTimeout(() => resolve({ timeout: true }), firstChunkTimeoutMs);
            })
            : null;
          const abortP = signal
            ? new Promise((resolve) => {
              abortWaiter = () => resolve({ aborted: true });
              if (signal.aborted) abortWaiter();
            })
            : null;
          const readP = reader.read().catch((error) => ({ error }));
          const result = await Promise.race([readP, timeoutP, abortP].filter(Boolean));
          abortWaiter = null;
          clearTimer();

          if (result.aborted || cancelled) {
            cleanup();
            await reader.cancel().catch(() => {});
            // After bytes, abort is the stall watchdog — error so pipe emits terminal.
            // Before bytes, client gone: close, no replay.
            if (gotByte && !cancelled) return fail(controller);
            controller.close();
            return;
          }
          if (result.error) throw result.error;

          if (result.timeout) {
            await reader.cancel().catch(() => {});
            if (await tryRetry(controller, "first-chunk timeout")) continue;
            cleanup();
            return fail(controller);
          }
          if (result.done) {
            if (!gotByte && await tryRetry(controller, "empty EOF")) continue;
            cleanup();
            if (!gotByte) return fail(controller);
            controller.close();
            return;
          }
          gotByte = true;
          controller.enqueue(result.value);
          return;
        }
      } catch (e) {
        cleanup();
        try { controller.error(e); } catch { /* closed */ }
      }
    },
    cancel() {
      cancelled = true;
      cleanup();
      reader?.cancel().catch(() => {});
    },
  });

  async function tryRetry(controller, reason) {
    if (retried || cancelled || signal?.aborted) return false;
    retried = true;
    log?.warn?.("STREAM", `zero-byte ${reason} | retrying once`);
    const next = await reexecute();
    if (cancelled || signal?.aborted) {
      await next?.cancel?.().catch(() => {});
      cleanup();
      controller.close();
      return false;
    }
    if (!next) return false;
    reader = next.getReader();
    gotByte = false;
    return true;
  }
}
