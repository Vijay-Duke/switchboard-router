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
import { buildRequestSignals } from "./fingerprint.js";
import {
  readRoutingCache,
  writeRoutingCache,
  invalidateRoutingCache,
} from "./routingCache.js";
import { deriveClusterGuess } from "./taxonomy.js";
import { splitPoolByTier, pickBanditPolicy, pickByObjective } from "./objective.js";
import { createJudgeContext, takeJudgeEscalation } from "./judge.js";

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

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_AUTO_DEPTH = 2;
/** Hard cap on explorationRate (dashboard + strategy); name documents [0, 0.2]. */
export const EXPLORATION_RATE_CAP = 0.2;
/** TTL for high-confidence cached routes; the bound forces periodic re-routing. */
export const CACHED_ROUTE_TTL_MS = 10 * 60 * 1000;
/** Prefix used by cached routes so settings changes can invalidate them. */
export const CACHED_ROUTE_PREFIX = "route:";

/** @param {string} comboName @param {string} fingerprint */
function cachedRouteKey(comboName, fingerprint) {
  return `${CACHED_ROUTE_PREFIX}${comboName}:${fingerprint}`;
}

/** Drop cached routes for one combo, or all combos when omitted. */
export function invalidateCachedRoutes(comboName) {
  invalidateRoutingCache(
    comboName ? `${CACHED_ROUTE_PREFIX}${comboName}:` : CACHED_ROUTE_PREFIX
  );
}

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
  applyJudgeScore = async () => {},
  autoDepth = 0,
  clientAbortSignal = null,
}) {
  if (autoDepth >= MAX_AUTO_DEPTH) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Auto combo "${comboName}" recursion limit (depth ${autoDepth})`
    );
  }

  // Auto combos require an explicit router selection. A hidden default can
  // silently turn an invalid combo into an unexpected billable router call.
  if (!strategy.routerModel || typeof strategy.routerModel !== "string") {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Auto combo "${comboName}" has no routerModel configured — select a router model in the combo's Auto settings`
    );
  }

  const {
    routerModel,
    objective,
    explorationRate,
    routerTimeoutMs,
    heuristicFirst,
    childDepth,
    tuning,
  } = resolveAutoSettings({ strategy, autoDepth });

  // SPEC §6: exclude router from pool; empty pool → 400 (do not re-add router as worker)
  const pool = buildWorkerPool({ models, routerModel, strategy });

  if (!pool.length) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Auto combo "${comboName}" has empty worker pool (add models besides router)`
    );
  }

  const emitHeaders = strategy.emitAutoRouterHeaders !== false;
  const windowDays = strategy.learningWindowDays ?? 14;

  // Sampled quality judge (Auto v2). Null when disabled (judgeSampleRate 0) so the
  // hot path pays nothing. Judge work is always fire-and-forget and fail-open.
  const judgeCtx = createJudgeContext({
    tuning,
    routerModel,
    comboName,
    handleSingleModel,
    extractAssistantText,
    applyJudgeScore,
    log,
  });

  const { candidates, shortcut } = prepareAutoCandidates({
    body,
    pool,
    heuristicFirst,
    log,
  });

  // Single-worker / heuristic shortcuts: execute without poisoning the bandit table
  if (shortcut) {
    return executeAndRecord({
      body,
      worker: shortcut.worker,
      pool,
      handleSingleModel,
      log,
      comboName,
      routerModel,
      objective,
      pick: shortcut.pick,
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

  const { learning, stats } = await loadAutoRoutingData({
    comboName,
    strategy,
    loadLearning,
    loadStats,
    log,
  });
  // Tier membership for the policy fast path escalation + failure reordering.
  const tierSplit = splitPoolByTier(candidates);
  const route = await selectAutoWorker({
    body,
    models,
    candidates,
    comboName,
    strategy,
    learning,
    stats,
    objective,
    explorationRate,
    routerModel,
    routerTimeoutMs,
    childDepth,
    tuning,
    tierSplit,
    handleSingleModel,
    log,
    clientAbortSignal,
  });
  if (route.response) return route.response;

  return executeAndRecord({
    body,
    worker: route.pick.model,
    pool: candidates,
    handleSingleModel,
    log,
    comboName,
    routerModel,
    objective,
    pick: route.pick,
    routerLatencyMs: route.routerLatencyMs,
    learningVersionId: learning?.id || strategy.activeLearningVersionId || null,
    exploration: route.exploration,
    signals: route.signals,
    recordEvent,
    alternates: route.pick.alternates,
    stats,
    autoDepth: childDepth,
    routerInPool: route.routerInPool,
    emitHeaders,
    loadClusterP50,
    windowDays,
    clientAbortSignal,
    judgeCtx,
    tierSplit,
  });
}

function resolveAutoSettings({ strategy, autoDepth }) {
  const routerModel = strategy.routerModel;
  const objective = strategy.objective || "balanced";
  const explorationRate = clampExploration(strategy.explorationRate ?? 0.05);
  const tuning = strategy.autoTuning || {};
  const routerTimeoutMs = resolveRouterTimeoutMs(tuning.routerTimeoutMs);
  // capacityAutoSwitch (combo setting) gates heuristic pre-filter; autoTuning.heuristicFirst is finer knob
  const capacityAutoSwitch = strategy.capacityAutoSwitch !== false;
  const heuristicFirst = capacityAutoSwitch && tuning.heuristicFirst !== false;
  return {
    routerModel,
    objective,
    explorationRate,
    routerTimeoutMs,
    heuristicFirst,
    childDepth: autoDepth + 1,
    tuning,
  };
}

function buildWorkerPool({ models, routerModel, strategy }) {
  // Nested combos as workers are an explicit non-goal (SPEC §2) — drop them if still listed
  let pool = (models || []).filter((m) => m && m !== routerModel);
  if (typeof strategy.filterWorker === "function") {
    pool = pool.filter((m) => strategy.filterWorker(m));
  }
  return pool;
}

function prepareAutoCandidates({ body, pool, heuristicFirst, log }) {
  if (pool.length === 1) {
    log?.info?.("AUTO", `pool size 1 → direct ${pool[0]}`);
    return {
      candidates: pool,
      shortcut: {
        worker: pool[0],
        pick: {
          model: pool[0],
          cluster: "general",
          confidence: "high",
          reason: "single_worker",
          alternates: [],
        },
      },
    };
  }

  let candidates = pool;
  if (!heuristicFirst) return { candidates, shortcut: null };

  const required = detectRequiredCapabilities(body);
  if (required.size === 0) return { candidates, shortcut: null };

  const needed = [...required];
  const able = pool.filter((id) => modelHasCaps(id, needed));
  if (able.length === 1) {
    log?.info?.("AUTO", `only one model capable of [${needed}] → ${able[0]}`);
    return {
      candidates,
      shortcut: {
        worker: able[0],
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
      },
    };
  }

  candidates = able.length > 1
    ? reorderByCapabilities(able, required)
    : reorderByCapabilities(pool, required);
  return { candidates, shortcut: null };
}

async function loadAutoRoutingData({ comboName, strategy, loadLearning, loadStats, log }) {
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
  return { learning, stats };
}

async function selectAutoWorker({
  body,
  models,
  candidates,
  comboName,
  strategy,
  learning,
  stats,
  objective,
  explorationRate,
  routerModel,
  routerTimeoutMs,
  childDepth,
  tuning,
  tierSplit = null,
  handleSingleModel,
  log,
  clientAbortSignal,
}) {
  const routerInPool = (models || []).includes(routerModel);
  if (routerInPool) {
    log?.info?.("AUTO", `router ${routerModel} also listed in models — excluded from worker pool`);
  }

  const signals = buildRequestSignals(body);
  const cachedRoutesEnabled = tuning.cachedRoutes !== false;
  const cacheKey = cachedRouteKey(comboName, signals.fingerprint);
  if (clientAbortSignal?.aborted) {
    return { response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Client disconnected") };
  }

  let pick = null;
  let routerLatencyMs = 0;
  let usedCachedRoute = false;

  // ── Pre-generation bandit policy fast path (Auto v2) ──────────────────────
  // When the cluster is unambiguous from signals AND the promoted bandit has a
  // clear winner (n≥10, solo or >15 lead), pick without the router LLM. Events
  // still record; exploration still applies below.
  if (tuning.policyFastPath !== false && !clientAbortSignal?.aborted) {
    const clusterGuess = deriveClusterGuess(signals);
    if (clusterGuess) {
      const policy = pickBanditPolicy(
        learning?.banditTable || null,
        clusterGuess,
        candidates,
        objective
      );
      if (policy && candidates.includes(policy.model)) {
        log?.info?.(
          "AUTO",
          `bandit_policy → ${policy.model} cluster=${clusterGuess} ` +
            `(${policy.lead === Infinity ? "solo" : `lead ${Math.round(policy.lead)}`})`
        );
        pick = {
          model: policy.model,
          cluster: clusterGuess,
          confidence: "high",
          reason: "bandit_policy",
          alternates: candidates.filter((c) => c !== policy.model).slice(0, 2),
        };
      }
    }
  }

  if (!pick && cachedRoutesEnabled && !clientAbortSignal?.aborted) {
    const cachedPick = readRoutingCache(cacheKey);
    if (cachedPick && candidates.includes(cachedPick.model)) {
      log?.info?.("AUTO", `cached route → ${cachedPick.model} (fp ${signals.fingerprint})`);
      pick = {
        model: cachedPick.model,
        cluster: cachedPick.cluster || "general",
        confidence: cachedPick.confidence || "high",
        reason: "cached_route",
        alternates: candidates.filter((c) => c !== cachedPick.model).slice(0, 2),
      };
      usedCachedRoute = true;
    } else if (cachedPick) {
      invalidateRoutingCache(cacheKey);
    }
  }

  if (!pick) {
    const healthByModel = healthFromStats(stats, candidates);
    const maxFewShots = tuning.maxFewShots ?? 5;
    const { messages } = buildRouterPrompt({
      comboName,
      pool: candidates,
      body,
      objective,
      learning,
      healthByModel,
      maxFewShots,
      signals,
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
    const routed = await callAutoRouter({
      routerBody,
      routerModel,
      candidates,
      routerTimeoutMs,
      childDepth,
      handleSingleModel,
      log,
      clientAbortSignal,
    });
    if (routed.response) return routed;
    pick = routed.pick;
    routerLatencyMs = routed.routerLatencyMs;
  }

  // ── One-shot judge-flag escalation (Auto v2) ──────────────────────────────
  // When the judge recently flagged this cluster past the objective threshold,
  // the NEXT policy/cached pick escalates to the frontier tier's best worker.
  const escalated = maybeEscalateForJudgeFlags({
    pick,
    tierSplit,
    candidates,
    comboName,
    objective,
    learning,
    log,
  });
  if (escalated) pick = escalated;

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

  if (
    cachedRoutesEnabled &&
    !usedCachedRoute &&
    !exploration &&
    // Escalation is one-shot; caching it would pin the frontier model for the TTL.
    pick.reason !== "judge_flag_escalation" &&
    pick.confidence === "high" &&
    !pick.parseError
  ) {
    writeRoutingCache(
      cacheKey,
      { model: pick.model, cluster: pick.cluster, confidence: pick.confidence },
      CACHED_ROUTE_TTL_MS
    );
  }

  return {
    pick,
    routerLatencyMs,
    exploration,
    signals,
    routerInPool,
  };
}

/**
 * Consume a one-shot judge-flag escalation for a policy/cached pick, returning a
 * new pick on the frontier tier's best worker, or null when it does not apply.
 */
function maybeEscalateForJudgeFlags({
  pick,
  tierSplit,
  candidates,
  comboName,
  objective,
  learning,
  log,
}) {
  if (!pick || tierSplit?.disabled) return null;
  if (pick.reason !== "bandit_policy" && pick.reason !== "cached_route") return null;

  // Check the frontier is usable BEFORE consuming the one-shot escalation, so a
  // threshold breach is never silently spent when there is nowhere to escalate.
  const frontier = (tierSplit?.frontier || []).filter((m) => candidates.includes(m));
  if (!frontier.length) return null;
  if (!takeJudgeEscalation(comboName, pick.cluster, objective)) return null;

  const best =
    pickByObjective(learning?.banditTable?.[pick.cluster] || {}, objective, frontier) ||
    frontier[0];
  if (!best || best === pick.model) return null;

  log?.info?.("AUTO", `judge_flag_escalation → ${best} (cluster=${pick.cluster})`);
  return {
    ...pick,
    model: best,
    reason: "judge_flag_escalation",
    confidence: "high",
    alternates: candidates.filter((c) => c !== best).slice(0, 2),
  };
}

async function callAutoRouter({
  routerBody,
  routerModel,
  candidates,
  routerTimeoutMs,
  childDepth,
  handleSingleModel,
  log,
  clientAbortSignal,
}) {
  let routerLatencyMs = 0;
  let pick;
  const t0 = Date.now();
  try {
    const routerRes = await withTimeout(
      (signal) =>
        handleSingleModel(routerBody, routerModel, {
          sourceFormatOverride: "openai",
          bypassNativePassthrough: true,
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
      log?.warn?.("AUTO", `router HTTP ${extracted.status}; using pool[0]`);
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
    if (clientAbortSignal?.aborted || e?.name === "AbortError" || e?.message === "client_aborted") {
      return { response: errorResponse(HTTP_STATUS.BAD_REQUEST, "Client disconnected") };
    }
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
  return { pick, routerLatencyMs };
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
  judgeCtx = null,
  tierSplit = null,
}) {
  const routerPickedWorker = pick.model;
  const clusterRefLatency = await resolveClusterReferenceLatency({
    loadClusterP50,
    comboName,
    cluster: pick.cluster,
    windowDays,
    stats,
  });

  /** Groups all attempt rows from this chat (fallback chain). */
  const requestId = randomUUID();
  const { attempts, attempted, tryWorker } = createWorkerAttemptRunner({
    body,
    handleSingleModel,
    log,
    autoDepth,
    clientAbortSignal,
  });
  const success = await runWorkerFallbackChain({
    worker,
    alternates,
    pool,
    attempted,
    tryWorker,
    tierSplit,
    log,
  });

  if (!success) {
    // Log failures even on skippedRouter shortcuts (single-worker empty → 503)
    // so Insights can show why; SQL bandit queries already exclude skippedRouter.
    recordAutoFailureEvents({
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
    return errorResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `Auto combo "${comboName}" all workers failed`
    );
  }

  // Intermediate failures (if any) before the winner — non-terminal bandit rows
  if (!skippedRouter && attempts.some((a) => !a.ok)) {
    recordAutoFailureEvents({
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

  return finalizeSuccessfulWorker({
    success,
    attempts,
    requestId,
    routerPickedWorker,
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
    recordEvent,
    log,
    routerInPool,
    emitHeaders,
    clusterRefLatency,
    judgeCtx,
  });
}

async function finalizeSuccessfulWorker({
  success,
  attempts,
  requestId,
  routerPickedWorker,
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
  recordEvent,
  log,
  routerInPool,
  emitHeaders,
  clusterRefLatency,
  judgeCtx = null,
}) {
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
  const baseEvent = buildBaseAutoEvent({
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
    winner,
    result,
    latencyMs,
    requestFallbackUsed: requestUsedFallback,
    clusterRefLatency,
    attempts,
    requestId,
  });

  if (skippedRouter) {
    // Do not write bandit-poisoning success events for heuristic/single shortcuts,
    // but still emit headers so clients can see auto was skipped. No requestId
    // header here: shortcuts record no terminal event, so feedback would 404.
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
      judgeCtx,
    });
  }

  // Non-streaming: use probe/pre-inspect when available; else clone+parse
  const { tokensIn, tokensOut, hasCompletion } = await inspectNonStreamingResult({
    result,
    preInspect,
  });
  // Sample the judge FIRST, then clone — so the ~93% of unsampled responses pay
  // nothing. Clone BEFORE withAutoRouterHeaders takes result.body (cloning after
  // the transfer makes the two readers contend on one stream).
  const judgeClone =
    judgeCtx && hasCompletion && judgeCtx.shouldSample()
      ? safeCloneResponse(result)
      : null;

  const outcomeScore = fireRecordEvent(recordEvent, log, {
    ...baseEvent,
    hasCompletion,
    tokensIn,
    tokensOut,
    routerInPool,
  });

  // Non-blocking quality judge (Auto v2) — reads the pristine clone, never the
  // client-facing body.
  if (judgeClone) fireNonStreamJudge(judgeCtx, baseEvent, judgeClone, log);

  return emitHeaders
    ? withAutoRouterHeaders(result, {
        worker: winner,
        requestId,
        cluster: pick.cluster,
        confidence: pick.confidence,
        score: outcomeScore,
        routerLatencyMs,
        workerLatencyMs: latencyMs,
        exploration: baseEvent.exploration,
      })
    : result;
}

/** Clone a Response for out-of-band inspection; null when the body is unusable. */
function safeCloneResponse(response) {
  try {
    return response?.clone?.() || null;
  } catch {
    return null;
  }
}

/**
 * Fire the quality judge for a non-streaming worker response without blocking.
 * `judgeClone` is a pristine clone taken before the client body was transferred.
 * Fail-open.
 */
function fireNonStreamJudge(judgeCtx, baseEvent, judgeClone, log) {
  if (!judgeCtx || !judgeClone) return;
  try {
    Promise.resolve()
      .then(async () => {
        const extracted = await extractAssistantText(judgeClone);
        const assistantText = extracted?.text || "";
        if (!assistantText) return;
        await judgeCtx.runJudge({ baseEvent, assistantText });
      })
      .catch((e) => log?.warn?.("AUTO", `judge dispatch failed: ${e?.message || e}`));
  } catch (e) {
    log?.warn?.("AUTO", `judge dispatch failed: ${e?.message || e}`);
  }
}

async function resolveClusterReferenceLatency({
  loadClusterP50,
  comboName,
  cluster,
  windowDays,
  stats,
}) {
  // Prefer true cluster p50 when available; fall back to n-weighted mean of avgs
  let clusterRefLatency = null;
  if (typeof loadClusterP50 === "function" && cluster) {
    try {
      clusterRefLatency = await loadClusterP50(comboName, cluster, windowDays);
    } catch {
      clusterRefLatency = null;
    }
  }
  if (clusterRefLatency == null) {
    clusterRefLatency = clusterLatencyRef(stats, cluster);
  }
  return clusterRefLatency;
}

function createWorkerAttemptRunner({
  body,
  handleSingleModel,
  log,
  autoDepth,
  clientAbortSignal,
}) {
  /** @type {Set<string>} */
  const attempted = new Set();
  /** @type {Array<{worker:string,ok:boolean,status:number,latencyMs:number}>} */
  const attempts = [];

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

  return { attempts, attempted, tryWorker };
}

async function runWorkerFallbackChain({
  worker,
  alternates,
  pool,
  attempted,
  tryWorker,
  tierSplit = null,
  log,
}) {
  // Primary pick
  let success = await tryWorker(worker);

  // Auto v2 escalation: when the cheap-tier primary failed and a frontier tier
  // exists, the whole remaining chain goes frontier-first — router-suggested
  // alternates do NOT jump ahead of the tier bump ("move up a tier" wins).
  const escalating = isCheapTierEscalation(tierSplit, worker);

  // Try all declared alternates (not just [0]) first — unless escalating.
  if (!success && !escalating && Array.isArray(alternates)) {
    for (const alt of alternates) {
      if (!alt || attempted.has(alt) || !pool.includes(alt)) continue;
      log?.info?.("AUTO", `worker failed → alternate ${alt}`);
      success = await tryWorker(alt);
      if (success) break;
    }
  }

  // Full pool fallback chain — skip every previously attempted model. When
  // escalating, frontier-tier workers come first (within tier keep pool order).
  if (!success && pool.length > 1) {
    const orderedPool = escalating
      ? orderPoolFrontierFirst(pool, tierSplit, worker, log)
      : pool;
    for (const m of orderedPool) {
      if (attempted.has(m)) continue;
      log?.info?.("AUTO", `fallback chain → ${m}`);
      success = await tryWorker(m);
      if (success) break;
    }
  }
  return success;
}

/** True when the failed primary was cheap-tier and a frontier tier exists. */
function isCheapTierEscalation(tierSplit, primaryWorker) {
  if (!tierSplit || tierSplit.disabled) return false;
  const cheapSet = new Set(tierSplit.cheap || []);
  const frontier = tierSplit.frontier || [];
  return cheapSet.has(primaryWorker) && frontier.length > 0;
}

/** Reorder the pool frontier-tier-first (within tier keep pool order). */
function orderPoolFrontierFirst(pool, tierSplit, primaryWorker, log) {
  const frontierSet = new Set(tierSplit.frontier || []);
  const frontier = pool.filter((m) => frontierSet.has(m));
  const rest = pool.filter((m) => !frontierSet.has(m));
  log?.info?.("AUTO", `escalation: cheap ${primaryWorker} failed → frontier-first fallback`);
  return [...frontier, ...rest];
}

function recordAutoFailureEvents({
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
  requestFallbackUsed,
  allFailed,
}) {
  if (!attempts.length) return;
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
    requestFallbackUsed,
    allFailed,
  });
}

function buildBaseAutoEvent({
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
  winner,
  result,
  latencyMs,
  requestFallbackUsed,
  clusterRefLatency,
  attempts,
  requestId,
}) {
  return {
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
    requestFallbackUsed,
    clusterP50LatencyMs: clusterRefLatency,
    attemptsSnapshot: [...attempts],
    requestId,
    terminal: true,
  };
}

async function inspectNonStreamingResult({ result, preInspect }) {
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
  return { tokensIn, tokensOut, hasCompletion };
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
