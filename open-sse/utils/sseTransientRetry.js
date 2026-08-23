import { DEFAULT_RETRY_CONFIG, resolveRetryEntry } from "../config/runtimeConfig.js";

const DEFAULT_PATTERNS = ["server_is_overloaded", "service_unavailable_error"];
const PEEK_BYTES = 4096;

function abortError(signal) {
  const error = new Error(signal?.reason?.message || "Request aborted");
  error.name = "AbortError";
  return error;
}

function waitForDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", aborted);
      resolve();
    };
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", aborted);
      reject(abortError(signal));
    };
    const timer = setTimeout(done, delayMs);
    signal?.addEventListener?.("abort", aborted, { once: true });
  });
}

function parseFrame(frame) {
  let event = "";
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  const rawData = data.join("\n");
  let parsed = null;
  try { parsed = JSON.parse(rawData); } catch { /* raw error frames remain detectable */ }
  return { event, parsed, rawData };
}

function transientMarker({ event, parsed, rawData }) {
  const type = parsed?.type || event;
  const error = parsed?.error || parsed?.response?.error;
  const isError = event === "error" || type === "error" || type === "response.failed" || type?.endsWith?.(".error") || !!error;
  if (!isError) return null;
  const errorText = parsed ? JSON.stringify(error || parsed) : rawData;
  return DEFAULT_PATTERNS.find((pattern) => errorText.includes(pattern)) || null;
}

function isMeaningfulFrame({ event, parsed }) {
  const type = parsed?.type || event;
  if (!type || type === "error" || type === "response.failed" || type?.endsWith?.(".error") || parsed?.error || parsed?.response?.error) return false;
  return type.startsWith("response.output_")
    || type.startsWith("response.content_part.")
    || type.startsWith("response.function_call")
    || type.startsWith("response.reasoning")
    || type.startsWith("response.refusal")
    || type.startsWith("response.image_generation_call.");
}

function reassemble(reader, chunks) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function peekResponse(response) {
  if (!response?.ok || !response.body) return { matched: null, replacementBody: null };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytesRead = 0;
  let pending = "";
  let meaningfulSeen = false;
  let matched = null;

  try {
    while (bytesRead < PEEK_BYTES && !matched && !meaningfulSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytesRead += value.byteLength;
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() || "";
      for (const frame of frames) {
        const parsedFrame = parseFrame(frame);
        if (isMeaningfulFrame(parsedFrame)) meaningfulSeen = true;
        const marker = transientMarker(parsedFrame);
        if (marker && !meaningfulSeen) {
          matched = marker;
          break;
        }
      }
    }
    if (!matched && !meaningfulSeen) matched = transientMarker(parseFrame(pending));
  } catch {
    // Preserve the already-read bytes and let the replacement stream surface
    // the upstream read failure normally.
  }

  return { matched, replacementBody: reassemble(reader, chunks) };
}

function withBody(result, body) {
  if (!body) return result;
  return {
    ...result,
    response: new Response(body, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
    }),
  };
}

export async function executeWithPreOutputSseRetry({
  execute,
  retryConfig,
  signal,
  log,
  provider = "UPSTREAM",
}) {
  const config = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  const { attempts, delayMs } = resolveRetryEntry(config[503]);

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    const result = await execute();
    const peek = await peekResponse(result.response);
    const restored = withBody(result, peek.replacementBody);
    if (!peek.matched) return restored;
    if (attempt >= attempts) {
      log?.warn?.("RETRY", `${provider.toUpperCase()} | SSE transient "${peek.matched}" — retries exhausted (${attempt}/${attempts})`);
      return restored;
    }

    log?.debug?.("RETRY", `${provider.toUpperCase()} | SSE "${peek.matched}" retry ${attempt + 1}/${attempts} after ${delayMs / 1000}s`);
    try { await restored.response.body?.cancel?.("retrying transient SSE error"); } catch { /* noop */ }
    await waitForDelay(delayMs, signal);
  }
}
