/**
 * Merge caller cancellation with a local timeout signal.
 * @param {...AbortSignal|null|undefined} signals
 * @returns {AbortSignal|undefined}
 */
export function mergeAbortSignals(...signals) {
  const active = signals.filter((signal) => signal && typeof signal === "object");
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);

  const controller = new AbortController();
  const onAbort = (event) => {
    try { controller.abort(event?.target?.reason); } catch { /* best effort */ }
  };
  for (const signal of active) {
    if (signal.aborted) {
      onAbort({ target: signal });
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}
