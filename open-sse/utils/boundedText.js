// Bounded retention for streamed text kept only for observability.
//
// The SSE logger previously accumulated the full assistant output (content +
// thinking) with `+=` for the life of every stream, then handed it to
// saveRequestDetail — which truncates each field to a ~5 KB preview before
// storage. Under concurrent long-context agent traffic that retained
// megabytes per stream for a 200-char preview and churned old-space with
// repeated string flattening (2026-11-01 V8 OOM). This accumulator retains a
// head + tail preview and an exact total length; callers that need usage
// estimation already track totalContentLength separately.

export const DEFAULT_STREAM_PREVIEW_MAX_CHARS = 32 * 1024;

export function streamPreviewMaxChars(env = process.env) {
  const parsed = Number.parseInt(env?.STREAM_LOG_PREVIEW_MAX_CHARS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_PREVIEW_MAX_CHARS;
}

/**
 * @param {number} [maxChars] retained-character budget (head + tail)
 * @returns {{ append: (s: unknown) => void, text: () => string,
 *   readonly totalLength: number, readonly retainedLength: number,
 *   readonly truncated: boolean }}
 */
export function createBoundedTextAccumulator(maxChars = streamPreviewMaxChars()) {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_STREAM_PREVIEW_MAX_CHARS;
  const headCap = Math.ceil(budget / 2);
  const tailCap = budget - headCap;
  let head = "";
  let tail = "";
  let total = 0;

  return {
    append(value) {
      if (typeof value !== "string" || value.length === 0) return;
      total += value.length;
      let rest = value;
      if (head.length < headCap) {
        const take = rest.slice(0, headCap - head.length);
        head += take;
        rest = rest.slice(take.length);
      }
      if (rest.length > 0) {
        tail = tailCap > 0 ? (tail + rest).slice(-tailCap) : "";
      }
    },
    text() {
      const omitted = total - head.length - tail.length;
      if (omitted <= 0) return head + tail;
      return `${head}\n…[truncated ${omitted} chars]…\n${tail}`;
    },
    get totalLength() { return total; },
    get retainedLength() { return head.length + tail.length; },
    get truncated() { return total > head.length + tail.length; },
  };
}
