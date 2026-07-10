/**
 * Auto strategy: router LLM picks one worker from pool, then execute worker.
 * docs/switchboard/SPEC.md §6
 */
import { randomUUID } from "crypto";
import { detectRequiredCapabilities, reorderByCapabilities } from "../services/combo.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { errorResponse } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { buildRouterPrompt, healthFromStats, clusterLatencyRef } from "./buildRouterPrompt.js";
import { parseRouterPick } from "./parseRouterResponse.js";
import {
  acceptWorkerResponse,
  extractAssistantText,
  extractUsage,
  hasJsonCompletion,
} from "./autoResponse.js";
import {
  fireRecordEvent,
  flushFailureEvents,
  observeStreamAndRecord,
  withAutoRouterHeaders,
} from "./autoOutcome.js";

export {
  STREAM_PROBE_IDLE_MS,
  acceptWorkerResponse,
  chunkHasCompletion,
  extractAssistantText,
  extractUsageFromSseSlice,
  freshWindowHasSseError,
  hasJsonCompletion,
  hasStreamContent,
  isSseKeepaliveText,
  probeStreamForContent,
  restreamFromProbe,
} from "./autoResponse.js";

const DEFAULT_ROUTER = "claude/claude-opus-4-8";
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_AUTO_DEPTH = 2;
/** Hard cap on explorationRate (dashboard + strategy); name documents [0, 0.2]. */
export const EXPLORATION_RATE_CAP = 0.2;

/**
 * @param {object} opts
 * @param {object} opts.body
 * @param {string[]} opts.models - combo models (may include router)
 * @param {Function} opts.handleSingleModel - (body, modelStr, callOpts?) => Promise<Response>
 * @param {object} opts.log
 * @param {string} opts.comboName
 * @param {object} [opts.strategy] - comboStrategies[comboName]
 * @param {Function} [opts.loadLearning]
 * @param {Function} [opts.loadStats]
 * @param {Function} [opts.loadClusterP50] - (combo, cluster, days) => Promise<number|null>
 * @param {Function} [opts.recordEvent]
 * @param {number} [opts.autoDepth] - recursion depth (reject at MAX_AUTO_DEPTH)
 * @param {AbortSignal} [opts.clientAbortSignal] - client disconnect aborts router + workers
 */
export async function handleAutoChat({
  body,
  models,
  handleSingleModel,
  log,
  comboName,
  strategy = {},
  loadLearning = async () => null,
  loadStats = async () => [],
  loadClusterP50 = null,
  recordEvent = async () => {},
  autoDepth = 0,
  clientAbortSignal = null,
}) {
  if (autoDepth >= MAX_AUTO_DEPTH) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Auto combo "${comboName}" recursion limit (depth ${autoDepth})`
    );
  }

  const routerModel = strategy.routerModel || DEFAULT_ROUTER;
  const objective = strategy.objective || "balanced";
  const explorationRate = clampExploration(strategy.explorationRate ?? 0.05);
  const tuning = strategy.autoTuning || {};
  const routerTimeoutMs = resolveRouterTimeoutMs(tuning.routerTimeoutMs);
  // capacityAutoSwitch (combo setting) gates heuristic pre-filter; autoTuning.heuristicFirst is finer knob
  const capacityAutoSwitch = strategy.capacityAutoSwitch !== false;
  const heuristicFirst = capacityAutoSwitch && tuning.heuristicFirst !== false;
  const childDepth = autoDepth + 1;

  // SPEC §6: exclude router from pool; empty pool → 400 (do not re-add router as worker)
  let pool = (models || []).filter((m) => m && m !== routerModel);
  // Nested combos as workers are an explicit non-goal (SPEC §2) — drop them if still listed
  if (typeof strategy.filterWorker === "function") {
    pool = pool.filter((m) => strategy.filterWorker(m));
  }

  if (!pool.length) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Auto combo "${comboName}" has empty worker pool (add models besides router)`
    );
  }

  const emitHeaders = strategy.emitAutoRouterHeaders !== false;
  const windowDays = strategy.learningWindowDays ?? 14;

  // Single-worker / heuristic shortcuts: execute without poisoning the bandit table
  if (pool.length === 1) {
    log?.info?.("AUTO", `pool size 1 → direct ${pool[0]}`);
    return executeAndRecord({
      body,
      worker: pool[0],
      pool,
      handleSingleModel,
      log,
      comboName,
      routerModel,
      objective,
      pick: {
        model: pool[0],
        cluster: "general",
        confidence: "high",
        reason: "single_worker",
        alternates: [],
      },
      routerLatencyMs: 0,
      learningVersionId: null,
      exploration: false,
      signals: null,
      recordEvent,
      skippedRouter: true,
      stats: [],
      autoDepth: childDepth,
      emitHeaders,
      loadClusterP50,
      windowDays,
      clientAbortSignal,
    });
  }

  let candidates = pool;
  if (heuristicFirst) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const needed = [...required];
      const able = pool.filter((id) => modelHasCaps(id, needed));
      if (able.length === 1) {
        log?.info?.("AUTO", `only one model capable of [${needed}] → ${able[0]}`);
        return executeAndRecord({
          body,
          worker: able[0],
          pool,
          handleSingleModel,
          log,
          comboName,
          routerModel,
          objective,
          pick: {
            model: able[0],
            cluster: needed.includes("vision")
              ? "vision"
              : needed.includes("pdf")
                ? "document"
                : "general",
            confidence: "high",
            reason: "heuristic_only_capable",
            alternates: [],
          },
          routerLatencyMs: 0,
          learningVersionId: null,
          exploration: false,
          signals: null,
          recordEvent,
          skippedRouter: true,
          stats: [],
          autoDepth: childDepth,
          emitHeaders,
          loadClusterP50,
          windowDays,
          clientAbortSignal,
        });
      }
      if (able.length > 1) {
        candidates = reorderByCapabilities(able, required);
      } else {
        candidates = reorderByCapabilities(pool, required);
      }
    }
  }

  const learningEnabled = strategy.learningEnabled !== false;
  // freezeLearning / activeLearningVersionId: loadLearning should resolve the pin or promoted version
  let learning = null;
  let stats = [];
  if (learningEnabled || strategy.activeLearningVersionId) {
    try {
      learning = await loadLearning(comboName, strategy);
    } catch (e) {
      log?.warn?.("AUTO", `loadLearning failed: ${e.message}`);
    }
  }
  try {
    stats = await loadStats(comboName, strategy.learningWindowDays ?? 14);
  } catch {
    /* fail-open */
  }

  const routerInPool = (models || []).includes(routerModel);
  if (routerInPool) {
    log?.info?.("AUTO", `router ${routerModel} also listed in models — excluded from worker pool`);
  }

  const healthByModel = healthFromStats(stats, candidates);
  const maxFewShots = strategy.autoTuning?.maxFewShots ?? 5;
  const { messages, signals } = buildRouterPrompt({
    comboName,
    pool: candidates,
    body,
    objective,
    learning,
    healthByModel,
    maxFewShots,
  });

  // Always OpenAI wire shape for the router call so system prompt is not dropped
  // on Claude/Gemini client endpoints (sourceFormatOverride forced in callOpts).
  const routerBody = {
    model: routerModel,
    messages,
    stream: false,
    temperature: 0,
    max_tokens: 256,
  };

  if (clientAbortSignal?.aborted) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Client disconnected");
  }

  let routerLatencyMs = 0;
  let pick;
  const t0 = Date.now();
  try {
    const routerRes = await withTimeout(
      (signal) =>
        handleSingleModel(routerBody, routerModel, {
          sourceFormatOverride: "openai",
          signal: mergeAbortSignals(signal, clientAbortSignal),
          autoDepth: childDepth,
          // Global caveman/ponytail/headroom must not rewrite router JSON prompt
          bypassPromptFilters: true,
        }),
      routerTimeoutMs,
      "router_timeout",
      clientAbortSignal
    );
    routerLatencyMs = Date.now() - t0;
    const extracted = await extractAssistantText(routerRes);
    if (extracted.httpError) {
      log?.warn?.(
        "AUTO",
        `router HTTP ${extracted.status}; using pool[0]`
      );
      pick = {
        model: candidates[0],
        cluster: "unknown",
        confidence: "low",
        reason: extracted.httpError,
        alternates: candidates.slice(1, 3),
        parseError: extracted.httpError,
      };
    } else {
      pick = parseRouterPick(extracted.text, candidates);
      if (pick.parseError) {
        log?.warn?.("AUTO", `router parse ${pick.parseError}; using ${pick.model}`);
      } else {
        log?.info?.(
          "AUTO",
          `router → ${pick.model} cluster=${pick.cluster} conf=${pick.confidence} (${routerLatencyMs}ms)`
        );
      }
    }
  } catch (e) {
    routerLatencyMs = Date.now() - t0;
    log?.warn?.("AUTO", `router failed: ${e.message}; pool[0]`);
    pick = {
      model: candidates[0],
      cluster: "unknown",
      confidence: "low",
      reason: e.message || "router_error",
      alternates: candidates.slice(1, 3),
      parseError: e.message === "router_timeout" ? "router_timeout" : "error",
    };
  }

  let exploration = false;
  if (Math.random() < explorationRate && candidates.length > 1) {
    const rnd = candidates[Math.floor(Math.random() * candidates.length)];
    if (rnd !== pick.model) {
      log?.info?.("AUTO", `exploration → ${rnd} (ε=${explorationRate})`);
      pick = {
        ...pick,
        model: rnd,
        reason: `exploration:${pick.reason || ""}`,
        confidence: "low",
      };
      exploration = true;
    }
  }

  return executeAndRecord({
    body,
    worker: pick.model,
    pool: candidates,
    handleSingleModel,
    log,
    comboName,
    routerModel,
    objective,
    pick,
    routerLatencyMs,
    learningVersionId: learning?.id || strategy.activeLearningVersionId || null,
    exploration,
    signals,
    recordEvent,
    alternates: pick.alternates,
    stats,
    autoDepth: childDepth,
    routerInPool,
    emitHeaders,
    loadClusterP50,
    windowDays,
    clientAbortSignal,
  });
}

async function executeAndRecord({
  body,
  worker,
  pool,
  handleSingleModel,
  log,
  comboName,
  routerModel,
  objective,
  pick,
  routerLatencyMs,
  learningVersionId,
  exploration,
  signals,
  recordEvent,
  alternates = [],
  skippedRouter = false,
  stats = [],
  autoDepth = 1,
  routerInPool = false,
  emitHeaders = true,
  loadClusterP50 = null,
  windowDays = 14,
  clientAbortSignal = null,
}) {
  const routerPickedWorker = pick.model;
  // Prefer true cluster p50 when available; fall back to n-weighted mean of avgs
  let clusterRefLatency = null;
  if (typeof loadClusterP50 === "function" && pick.cluster) {
    try {
      clusterRefLatency = await loadClusterP50(comboName, pick.cluster, windowDays);
    } catch {
      clusterRefLatency = null;
    }
  }
  if (clusterRefLatency == null) {
    clusterRefLatency = clusterLatencyRef(stats, pick.cluster);
  }
  /** Groups all attempt rows from this chat (fallback chain). */
  const requestId = randomUUID();
  /** @type {Set<string>} */
  const attempted = new Set();
  /** @type {Array<{worker:string,ok:boolean,status:number,latencyMs:number}>} */
  const attempts = [];

  // Collect failures; flush after the chain so we can mark the last as terminal
  // when everything fails (request-level counts use meta.terminal + requestId).
  // Empty 2xx (stream or non-stream) is treated as failure so the chain can
  // fall back before anything is committed to the client.
  const tryWorker = async (modelStr) => {
    if (attempted.has(modelStr)) return null;
    attempted.add(modelStr);
    const t = Date.now();
    let result = null;
    if (clientAbortSignal?.aborted) {
      attempts.push({
        worker: modelStr,
        ok: false,
        status: 499,
        latencyMs: Date.now() - t,
        reason: "client_aborted",
      });
      return null;
    }
    try {
      result = await handleSingleModel(cloneBody(body), modelStr, {
        autoDepth,
        signal: clientAbortSignal || undefined,
      });
    } catch (e) {
      log?.warn?.("AUTO", `worker ${modelStr} threw: ${e.message}`);
      attempts.push({
        worker: modelStr,
        ok: false,
        status: 500,
        latencyMs: Date.now() - t,
      });
      return null;
    }
    const ttfbMs = Date.now() - t;

    if (!result?.ok) {
      attempts.push({
        worker: modelStr,
        ok: false,
        status: result?.status ?? 500,
        latencyMs: ttfbMs,
      });
      try {
        await result?.body?.cancel?.();
      } catch {
        /* ignore */
      }
      return null;
    }

    // Probe: empty streams fail before client commit so the chain can fall back.
    // Idle timeout only — active thinking streams keep waiting (see probeStreamForContent).
    const accepted = await acceptWorkerResponse(result, log, {
      abortSignal: clientAbortSignal,
    });
    const latencyMs = Date.now() - t;
    if (!accepted.ok) {
      log?.warn?.(
        "AUTO",
        `worker ${modelStr} empty/incomplete response → fallback (${accepted.reason || "empty"})`
      );
      attempts.push({
        worker: modelStr,
        ok: false,
        status: 502,
        latencyMs,
        reason: accepted.reason || "empty_response",
      });
      return null;
    }

    attempts.push({
      worker: modelStr,
      ok: true,
      status: accepted.result?.status ?? 200,
      latencyMs,
    });
    return {
      result: accepted.result,
      latencyMs,
      modelStr,
      preInspect: accepted.preInspect || null,
      ttfbMs,
      workerStartMs: t,
    };
  };

  // Primary pick
  let success = await tryWorker(worker);

  // Try all declared alternates (not just [0]), skipping already-attempted
  if (!success && Array.isArray(alternates)) {
    for (const alt of alternates) {
      if (!alt || attempted.has(alt) || !pool.includes(alt)) continue;
      log?.info?.("AUTO", `worker failed → alternate ${alt}`);
      success = await tryWorker(alt);
      if (success) break;
    }
  }

  // Full pool fallback chain — skip every previously attempted model
  if (!success && pool.length > 1) {
    for (const m of pool) {
      if (attempted.has(m)) continue;
      log?.info?.("AUTO", `fallback chain → ${m}`);
      success = await tryWorker(m);
      if (success) break;
    }
  }

  if (!success) {
    // Log failures even on skippedRouter shortcuts (single-worker empty → 503)
    // so Insights can show why; SQL bandit queries already exclude skippedRouter.
    if (attempts.length) {
      flushFailureEvents({
        attempts,
        recordEvent,
        log,
        body,
        comboName,
        signals,
        pick,
        routerModel,
        routerLatencyMs,
        learningVersionId,
        exploration,
        skippedRouter,
        objective,
        routerPickedWorker,
        clusterRefLatency,
        requestId,
        requestFallbackUsed: attempts.length > 1,
        allFailed: true,
      });
    }
    return errorResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `Auto combo "${comboName}" all workers failed`
    );
  }

  // Intermediate failures (if any) before the winner — non-terminal bandit rows
  if (!skippedRouter && attempts.some((a) => !a.ok)) {
    flushFailureEvents({
      attempts, // full chain for meta.attempts; only !ok rows are written
      recordEvent,
      log,
      body,
      comboName,
      signals,
      pick,
      routerModel,
      routerLatencyMs,
      learningVersionId,
      exploration,
      skippedRouter,
      objective,
      routerPickedWorker,
      clusterRefLatency,
      requestId,
      requestFallbackUsed: true,
      allFailed: false,
    });
  }

  const {
    result,
    latencyMs,
    modelStr: winner,
    preInspect,
    ttfbMs,
    workerStartMs,
  } = success;
  const isRescue = winner !== routerPickedWorker;
  const requestUsedFallback = attempts.some((a) => !a.ok) || isRescue;

  // For streaming: observe completion before finalizing score; return response immediately.
  // Rescuer is NOT penalized for earlier failures (score path: fallbackUsed/retries false).
  // Stored column fallbackUsed is request-level (true if rescue/fallback happened).
  const baseEvent = {
    body,
    comboName,
    signals,
    pick,
    routerModel,
    routerLatencyMs,
    learningVersionId,
    exploration,
    skippedRouter,
    objective,
    routerPickedWorker,
    pickedWorker: winner,
    workerStatus: result.status,
    workerLatencyMs: latencyMs,
    workerOk: true,
    // Score attribution: only penalize if this worker itself needed retries (never for rescue)
    fallbackUsed: false,
    retries: 0,
    // Column + meta: the request used a fallback chain
    requestFallbackUsed: requestUsedFallback,
    clusterP50LatencyMs: clusterRefLatency,
    attemptsSnapshot: [...attempts],
    requestId,
    terminal: true,
  };

  if (skippedRouter) {
    // Do not write bandit-poisoning success events for heuristic/single shortcuts,
    // but still emit headers so clients can see auto was skipped.
    return emitHeaders
      ? withAutoRouterHeaders(result, {
          worker: winner,
          cluster: pick.cluster,
          confidence: pick.confidence || "high",
          routerLatencyMs,
          workerLatencyMs: latencyMs,
          skipped: true,
        })
      : result;
  }

  const ct = (result.headers?.get?.("content-type") || "").toLowerCase();
  const isStream = ct.includes("text/event-stream") || ct.includes("ndjson");

  if (isStream && result.body) {
    return observeStreamAndRecord({
      response: result,
      recordEvent,
      log,
      baseEvent,
      ttfbMs: ttfbMs ?? latencyMs,
      // Wall-clock from worker dispatch (includes probe) for accurate latency scoring
      workerStartMs: workerStartMs || Date.now() - latencyMs,
      emitHeaders,
      routerLatencyMs,
      routerInPool,
      // Probe may accept on first event before real completion; only seed tokens
      seedHasCompletion: !!preInspect?.hasCompletion,
      seedTokensIn: preInspect?.tokensIn ?? null,
      seedTokensOut: preInspect?.tokensOut ?? null,
    });
  }

  // Non-streaming: use probe/pre-inspect when available; else clone+parse
  let tokensIn = preInspect?.tokensIn ?? null;
  let tokensOut = preInspect?.tokensOut ?? null;
  let hasCompletion = !!preInspect?.hasCompletion;
  if (preInspect == null) {
    hasCompletion = false;
    try {
      const data = await result.clone().json();
      const usage = extractUsage(data);
      if (usage) {
        tokensIn = usage.prompt_tokens ?? null;
        tokensOut = usage.completion_tokens ?? null;
      }
      hasCompletion =
        hasJsonCompletion(data) ||
        (typeof tokensOut === "number" && tokensOut > 0);
    } catch {
      hasCompletion = false;
    }
  }
  const outcomeScore = fireRecordEvent(recordEvent, log, {
    ...baseEvent,
    hasCompletion,
    tokensIn,
    tokensOut,
    routerInPool,
  });

  return emitHeaders
    ? withAutoRouterHeaders(result, {
        worker: winner,
        cluster: pick.cluster,
        confidence: pick.confidence,
        score: outcomeScore,
        routerLatencyMs,
        workerLatencyMs: latencyMs,
        exploration: baseEvent.exploration,
      })
    : result;
}


function modelHasCaps(modelStr, needed) {
  const [provider, ...rest] = modelStr.split("/");
  const model = rest.join("/") || provider;
  const caps = getCapabilitiesForModel(provider, model) || {};
  for (const n of needed) {
    if (n === "vision" && !caps.vision) return false;
    if (n === "pdf" && !caps.pdf) return false;
  }
  return true;
}

function cloneBody(body) {
  try {
    return typeof structuredClone === "function"
      ? structuredClone(body)
      : JSON.parse(JSON.stringify(body));
  } catch {
    return { ...body };
  }
}

/**
 * Clamp exploration rate to [0, EXPLORATION_RATE_CAP].
 * NaN / non-finite → 0 (not a silent 0.05 default — callers pass defaults).
 */
export function clampExploration(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(EXPLORATION_RATE_CAP, x));
}

function resolveRouterTimeoutMs(raw) {
  const x = Number(raw);
  if (!Number.isFinite(x) || x <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(x, 120_000);
}

/** Merge AbortSignals — aborts when any source aborts. */
export function mergeAbortSignals(...signals) {
  const list = signals.filter((s) => s && typeof s === "object");
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  const ac = new AbortController();
  const onAbort = () => {
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  };
  for (const s of list) {
    if (s.aborted) {
      onAbort();
      return ac.signal;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return ac.signal;
}

/**
 * Race a signal-aware factory against a timeout; aborts the upstream on timeout.
 * @param {(signal: AbortSignal) => Promise<any>} factory
 * @param {number} ms
 * @param {string} label
 * @param {AbortSignal} [clientSignal]
 */
function withTimeout(factory, ms, label, clientSignal = null) {
  const timeoutMs = resolveRouterTimeoutMs(ms);
  const ac = new AbortController();
  const merged = mergeAbortSignals(ac.signal, clientSignal) || ac.signal;
  return new Promise((resolve, reject) => {
    if (clientSignal?.aborted) {
      reject(new Error("client_aborted"));
      return;
    }
    const t = setTimeout(() => {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
      reject(new Error(label || "timeout"));
    }, timeoutMs);
    const onClientAbort = () => {
      clearTimeout(t);
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
      reject(new Error("client_aborted"));
    };
    if (clientSignal) {
      clientSignal.addEventListener("abort", onClientAbort, { once: true });
    }
    Promise.resolve()
      .then(() => factory(merged))
      .then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
  });
}
