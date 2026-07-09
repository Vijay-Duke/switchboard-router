// @ts-check

export const MODEL_PROBE_CAPS = {
  defaultConcurrency: 4,
  maxConcurrency: 16,
  defaultBatchSize: 50,
  maxBatchSize: 200,
  defaultTimeoutMs: 20_000,
  maxTimeoutMs: 60_000,
};

function clampInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

export function clampProbeOptions(options = {}) {
  return {
    concurrency: clampInt(options.concurrency, MODEL_PROBE_CAPS.defaultConcurrency, MODEL_PROBE_CAPS.maxConcurrency),
    batchSize: clampInt(options.batchSize, MODEL_PROBE_CAPS.defaultBatchSize, MODEL_PROBE_CAPS.maxBatchSize),
    timeoutMs: clampInt(options.timeoutMs, MODEL_PROBE_CAPS.defaultTimeoutMs, MODEL_PROBE_CAPS.maxTimeoutMs),
  };
}
