// @ts-check
// In-process heap watchdog: the last line of defense before V8 aborts.
//
// On 2026-11-01 the server died twice with FatalProcessOutOfMemory
// (CheckIneffectiveMarkCompact → SIGABRT). A supervisor can only restart a
// process that actually exits, and a V8 abort loses buffered observability
// rows and in-flight state. This watchdog samples heapUsed against the V8
// heap limit and, on *sustained* critical pressure, flushes what it can and
// exits non-zero so PM2 / the CLI watchdog respawns a clean process in
// seconds instead of the process aborting mid-request. A single GC-lag spike
// never restarts: pressure must stay critical for several consecutive
// samples (default 4 × 15 s).
//
// Tunables (env): SWITCHBOARD_MEMORY_WATCHDOG=0 disables;
// SWITCHBOARD_MEMORY_SAMPLE_MS, SWITCHBOARD_MEMORY_WARN_FRACTION,
// SWITCHBOARD_MEMORY_CRITICAL_FRACTION, SWITCHBOARD_MEMORY_CRITICAL_SAMPLES.

const DEFAULT_SAMPLE_MS = 15_000;
const MIN_SAMPLE_MS = 1_000;
const DEFAULT_WARN_FRACTION = 0.8;
const DEFAULT_CRITICAL_FRACTION = 0.92;
const DEFAULT_CRITICAL_SAMPLES = 4;
const CRITICAL_FLUSH_TIMEOUT_MS = 2_000;

function parseFraction(raw, fallback) {
  const value = Number.parseFloat(raw || "");
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

export function resolveMemoryWatchdogConfig(env = process.env) {
  const sampleMsRaw = Number.parseInt(env?.SWITCHBOARD_MEMORY_SAMPLE_MS || "", 10);
  const samplesRaw = Number.parseInt(env?.SWITCHBOARD_MEMORY_CRITICAL_SAMPLES || "", 10);
  const warnFraction = parseFraction(env?.SWITCHBOARD_MEMORY_WARN_FRACTION, DEFAULT_WARN_FRACTION);
  let criticalFraction = parseFraction(env?.SWITCHBOARD_MEMORY_CRITICAL_FRACTION, DEFAULT_CRITICAL_FRACTION);
  if (criticalFraction <= warnFraction) criticalFraction = DEFAULT_CRITICAL_FRACTION;
  return {
    enabled: env?.SWITCHBOARD_MEMORY_WATCHDOG !== "0",
    sampleMs: Number.isFinite(sampleMsRaw) ? Math.max(MIN_SAMPLE_MS, sampleMsRaw) : DEFAULT_SAMPLE_MS,
    warnFraction,
    criticalFraction,
    criticalSamples: Number.isFinite(samplesRaw) && samplesRaw >= 1 ? samplesRaw : DEFAULT_CRITICAL_SAMPLES,
  };
}

/**
 * Pure pressure decision for one sample.
 * @param {{ fraction: number, consecutiveCritical: number }} sample
 * @param {ReturnType<typeof resolveMemoryWatchdogConfig>} config
 * @returns {{ level: "ok" | "warn" | "critical", consecutiveCritical: number, shouldRestart: boolean }}
 */
export function evaluateMemoryPressure(sample, config) {
  const fraction = Number.isFinite(sample?.fraction) ? sample.fraction : 0;
  if (fraction >= config.criticalFraction) {
    const consecutiveCritical = (sample.consecutiveCritical || 0) + 1;
    return {
      level: "critical",
      consecutiveCritical,
      shouldRestart: consecutiveCritical >= config.criticalSamples,
    };
  }
  if (fraction >= config.warnFraction) {
    return { level: "warn", consecutiveCritical: 0, shouldRestart: false };
  }
  return { level: "ok", consecutiveCritical: 0, shouldRestart: false };
}

function heapLimitBytes(usage) {
  try {
    // node:v8 is unavailable in some edge/test contexts; heapTotal is the
    // honest fallback (fraction then tracks committed-heap fill, which V8
    // grows toward the limit under pressure).
    const v8 = process.getBuiltinModule?.("node:v8");
    const limit = v8?.getHeapStatistics?.()?.heap_size_limit;
    if (Number.isFinite(limit) && limit > 0) return limit;
  } catch { /* fall through */ }
  return usage.heapTotal;
}

/** Point-in-time process memory for health/metrics surfaces. Never throws. */
export function getMemorySnapshot() {
  try {
    const usage = process.memoryUsage();
    const limit = heapLimitBytes(usage);
    return {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      heapTotalBytes: usage.heapTotal,
      heapLimitBytes: limit,
      externalBytes: usage.external,
      arrayBuffersBytes: usage.arrayBuffers || 0,
      heapFraction: limit > 0 ? usage.heapUsed / limit : 0,
      uptimeSeconds: Math.round(process.uptime()),
    };
  } catch {
    return null;
  }
}

const state = (globalThis.__switchboardMemoryWatchdog ??= {
  timer: null,
  consecutiveCritical: 0,
  lastSnapshot: null,
  restarting: false,
});

export function getLastMemorySnapshot() {
  return state.lastSnapshot || getMemorySnapshot();
}

function formatMb(bytes) {
  return `${Math.round((bytes || 0) / (1024 * 1024))}MB`;
}

/**
 * Start sampling. Idempotent across hot reloads via the global slot.
 * @param {{ onCritical?: (snapshot: object) => unknown,
 *   log?: { info?: Function, warn?: Function, error?: Function },
 *   exit?: (code: number) => void, config?: object }} [options]
 * @returns {boolean} true when the sampler is running
 */
export function startMemoryWatchdog(options = {}) {
  const config = options.config || resolveMemoryWatchdogConfig();
  if (!config.enabled) return false;
  if (state.timer) return true;

  const log = options.log || console;
  const exit = options.exit || ((code) => process.exit(code));
  log.info?.(
    `[MemoryWatchdog] sampling every ${config.sampleMs}ms; warn≥${Math.round(config.warnFraction * 100)}% ` +
    `critical≥${Math.round(config.criticalFraction * 100)}% ×${config.criticalSamples} of heap limit`
  );

  const sample = async () => {
    const snapshot = getMemorySnapshot();
    if (!snapshot) return;
    state.lastSnapshot = snapshot;
    const verdict = evaluateMemoryPressure(
      { fraction: snapshot.heapFraction, consecutiveCritical: state.consecutiveCritical },
      config
    );
    state.consecutiveCritical = verdict.consecutiveCritical;

    if (verdict.level === "warn") {
      log.warn?.(
        `[MemoryWatchdog] heap pressure: used=${formatMb(snapshot.heapUsedBytes)} limit=${formatMb(snapshot.heapLimitBytes)} ` +
        `(${(snapshot.heapFraction * 100).toFixed(1)}%) rss=${formatMb(snapshot.rssBytes)} external=${formatMb(snapshot.externalBytes)}`
      );
    }
    if (!verdict.shouldRestart || state.restarting) return;

    state.restarting = true;
    log.error?.(
      `[MemoryWatchdog] sustained critical heap pressure (${(snapshot.heapFraction * 100).toFixed(1)}% of ${formatMb(snapshot.heapLimitBytes)} ` +
      `for ${verdict.consecutiveCritical} samples); flushing and exiting for supervisor restart instead of V8 OOM abort`
    );
    try {
      await Promise.race([
        Promise.resolve().then(() => options.onCritical?.(snapshot)),
        new Promise((resolve) => setTimeout(resolve, CRITICAL_FLUSH_TIMEOUT_MS)),
      ]);
    } catch { /* best effort — exiting is the point */ }
    exit(1);
  };

  state.timer = setInterval(() => { void sample(); }, config.sampleMs);
  state.timer?.unref?.();
  return true;
}

export function __resetMemoryWatchdogForTests() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.consecutiveCritical = 0;
  state.lastSnapshot = null;
  state.restarting = false;
}
