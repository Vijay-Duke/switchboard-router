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
import { computeOutcomeScore } from "./scoring.js";

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
function observeStreamAndRecord({
  response,
  recordEvent,
  log,
  baseEvent,
  ttfbMs,
  workerStartMs = null,
  emitHeaders = true,
  routerLatencyMs = 0,
  routerInPool = false,
  seedHasCompletion = false,
  seedTokensIn = null,
  seedTokensOut = null,
}) {
  const body = response.body;
  const startedAt =
    typeof workerStartMs === "number" && Number.isFinite(workerStartMs)
      ? workerStartMs
      : Date.now() - (ttfbMs || 0);

  if (!body || typeof body.getReader !== "function") {
    fireRecordEvent(recordEvent, log, {
      ...baseEvent,
      hasCompletion: !!seedHasCompletion,
      tokensIn: seedTokensIn,
      tokensOut: seedTokensOut,
      workerLatencyMs: Date.now() - startedAt,
      routerInPool,
      metaExtra: { streamObserved: false },
    });
    return emitHeaders
      ? withAutoRouterHeaders(response, {
          worker: baseEvent.pickedWorker,
          cluster: baseEvent.pick?.cluster,
          confidence: baseEvent.pick?.confidence,
          routerLatencyMs,
          workerLatencyMs: Date.now() - startedAt,
          exploration: baseEvent.exploration,
        })
      : response;
  }

  const src = body.getReader();
  const decoder = new TextDecoder();
  // Do not seed buf with probe text — prefix is re-decoded from restreamed chunks
  let buf = "";
  let hasCompletion = !!seedHasCompletion;
  let tokensIn = seedTokensIn ?? null;
  let tokensOut = seedTokensOut ?? null;
  let died = false;
  let recorded = false;

  const applyUsageFromFresh = (slice) => {
    const usage = extractUsageFromSseSlice(slice);
    if (usage) {
      tokensIn = usage.prompt_tokens ?? tokensIn;
      tokensOut = usage.completion_tokens ?? tokensOut;
      if (tokensOut > 0) hasCompletion = true;
    }
    if (!hasCompletion && hasStreamContent(slice)) hasCompletion = true;
  };

  const finalize = (metaExtra = {}) => {
    if (recorded) return;
    recorded = true;
    try {
      const flush = decoder.decode();
      if (flush) applyUsageFromFresh(flush);
    } catch {
      /* ignore */
    }
    // Full worker latency: dispatch → probe → stream end (not TTFB + post-probe only)
    const totalMs = Date.now() - startedAt;
    const workerOk = hasCompletion && !died;
    fireRecordEvent(recordEvent, log, {
      ...baseEvent,
      workerOk: baseEvent.workerOk && workerOk,
      workerStatus: workerOk ? baseEvent.workerStatus : 502,
      workerLatencyMs: totalMs,
      hasCompletion,
      tokensIn,
      tokensOut,
      routerInPool,
      metaExtra: {
        streamObserved: true,
        streamDied: died,
        ttfbMs,
        ...metaExtra,
      },
    });
  };

  const clientBody = new ReadableStream({
    async pull(ctrl) {
      try {
        const { done, value } = await src.read();
        if (done) {
          ctrl.close();
          finalize();
          return;
        }
        if (value) {
          if (value.byteLength) {
            const fresh = decoder.decode(value, { stream: true });
            buf = (buf + fresh).slice(-128_000);
            if (!hasCompletion) applyUsageFromFresh(fresh.length < 512 ? buf.slice(-512) : fresh);
            else {
              // Still pick up usage if it arrives late
              const usage = extractUsageFromSseSlice(fresh);
              if (usage) {
                tokensIn = usage.prompt_tokens ?? tokensIn;
                tokensOut = usage.completion_tokens ?? tokensOut;
              }
            }
          }
          ctrl.enqueue(value);
        }
      } catch (e) {
        died = true;
        try {
          ctrl.error(e);
        } catch {
          /* ignore */
        }
        finalize({ streamError: e?.message || String(e) });
      }
    },
    async cancel(reason) {
      // Propagate to streamHandler cancel → abortController.abort()
      try {
        await src.cancel(reason);
      } catch {
        /* ignore */
      }
      // Esc mid-thinking: no content yet → do not poison bandit with a 502 failure
      if (!hasCompletion) {
        recorded = true; // suppress late finalize
        log?.info?.(
          "AUTO",
          `client disconnected before completion — skip scoring worker=${baseEvent.pickedWorker}`
        );
        return;
      }
      // Partial useful output already seen — score as success without failure penalty
      finalize({ clientDisconnected: true });
    },
  });

  const out = new Response(clientBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return emitHeaders
    ? withAutoRouterHeaders(out, {
        worker: baseEvent.pickedWorker,
        cluster: baseEvent.pick?.cluster,
        confidence: baseEvent.pick?.confidence,
        routerLatencyMs,
        workerLatencyMs: ttfbMs,
        exploration: baseEvent.exploration,
      })
    : out;
}

/**
 * Write bandit-attribution rows for failed workers in a chain.
 * When allFailed, only the last attempt is terminal (request-level count = 1).
 * When partial, every failure is non-terminal; winner is recorded separately as terminal.
 */
function flushFailureEvents({
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
  const fails = (attempts || []).filter((a) => !a.ok);
  fails.forEach((a, i) => {
    const isLast = i === fails.length - 1;
    const terminal = allFailed ? isLast : false;
    fireRecordEvent(recordEvent, log, {
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
      pickedWorker: a.worker,
      workerStatus: a.status,
      workerLatencyMs: a.latencyMs,
      workerOk: false,
      // Score path: this attempt itself failed (not a rescuer)
      fallbackUsed: fails.length > 1 && i > 0,
      retries: i,
      hasCompletion: false,
      tokensIn: null,
      tokensOut: null,
      clusterP50LatencyMs: clusterRefLatency,
      attemptsSnapshot: attempts,
      requestFallbackUsed: !!requestFallbackUsed || fails.length > 1,
      requestId,
      terminal,
    });
  });
}

function fireRecordEvent(recordEvent, log, args) {
  const {
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
    pickedWorker,
    workerStatus,
    workerLatencyMs,
    workerOk,
    fallbackUsed,
    retries,
    hasCompletion,
    tokensIn,
    tokensOut,
    clusterP50LatencyMs,
    attemptsSnapshot,
    requestFallbackUsed,
    routerInPool,
    metaExtra,
    requestId,
    terminal = true,
  } = args;

  // Score uses per-attempt fallbackUsed/retries (rescuer scored clean).
  const outcomeScore = computeOutcomeScore({
    workerOk,
    confidence: pick.confidence,
    workerLatencyMs,
    clusterP50LatencyMs: clusterP50LatencyMs ?? null,
    fallbackUsed,
    retries,
    hasCompletion,
    tokensOut,
  });

  // SPEC §11 — log outcome with score + latencies (prefer terminal / success lines)
  if (terminal || !workerOk) {
    log?.info?.(
      "AUTO",
      `outcome score=${outcomeScore} worker=${pickedWorker} cluster=${pick.cluster || "?"} ` +
        `router=${routerLatencyMs ?? 0}ms+worker=${workerLatencyMs ?? 0}ms` +
        (exploration ? " exploration" : "") +
        (workerOk ? "" : " FAIL") +
        (terminal ? " terminal" : " attempt")
    );
  }

  Promise.resolve(
    recordEvent({
      timestamp: new Date().toISOString(),
      comboName,
      requestId: requestId || null,
      // OpenAI `user` is a stable end-user id, not a session — prefer explicit session keys
      sessionId:
        body?.metadata?.session_id ||
        body?.metadata?.sessionId ||
        body?.metadata?.conversation_id ||
        null,
      requestFingerprint: signals?.fingerprint || null,
      cluster: pick.cluster,
      routerModel: skippedRouter ? null : routerModel,
      pickedWorker,
      alternates: pick.alternates || [],
      routerReason: pick.reason,
      routerConfidence: pick.confidence,
      routerLatencyMs,
      workerStatus,
      workerLatencyMs,
      // Column meaning: request used a fallback (any prior failure / rescue), not "this row retried"
      fallbackUsed: !!(requestFallbackUsed || fallbackUsed),
      retries: retries ?? 0,
      tokensIn: tokensIn ?? null,
      tokensOut: tokensOut ?? null,
      outcomeScore,
      objective,
      learningVersionId,
      meta: {
        exploration,
        skippedRouter,
        terminal: !!terminal,
        requestId: requestId || null,
        modalities: signals?.modalities,
        hasTools: signals?.hasTools,
        parseError: pick.parseError || null,
        routerPickedWorker,
        attempts: attemptsSnapshot || [],
        // Score inputs for recomputation (column fallbackUsed is request-level)
        scoreFallbackUsed: !!fallbackUsed,
        scoreRetries: retries ?? 0,
        // For few-shot summaries (LEARNING.md): first 120 chars of user intent
        userSummary: signals?.userSummary
          ? String(signals.userSummary).slice(0, 120)
          : null,
        routerInPool: !!routerInPool,
        ...(metaExtra || {}),
      },
    })
  ).catch((e) => log?.warn?.("AUTO", `recordEvent failed: ${e.message}`));

  return outcomeScore;
}

/** Opt-out response headers (default on; strategy.emitAutoRouterHeaders === false disables). */
function withAutoRouterHeaders(response, meta) {
  if (!response) return response;
  try {
    const headers = new Headers(response.headers);
    if (meta.worker) headers.set("X-Auto-Router-Worker", String(meta.worker));
    if (meta.cluster) headers.set("X-Auto-Router-Cluster", String(meta.cluster));
    if (meta.confidence) headers.set("X-Auto-Router-Confidence", String(meta.confidence));
    if (meta.score != null) headers.set("X-Auto-Router-Score", String(meta.score));
    if (meta.routerLatencyMs != null) {
      headers.set("X-Auto-Router-Router-Ms", String(Math.round(meta.routerLatencyMs)));
    }
    if (meta.workerLatencyMs != null) {
      headers.set("X-Auto-Router-Worker-Ms", String(Math.round(meta.workerLatencyMs)));
    }
    if (meta.exploration) headers.set("X-Auto-Router-Exploration", "1");
    if (meta.skipped) headers.set("X-Auto-Router-Skipped", "1");
    // Expose for browser clients
    const expose = headers.get("Access-Control-Expose-Headers") || "";
    const needed = [
      "X-Auto-Router-Worker",
      "X-Auto-Router-Cluster",
      "X-Auto-Router-Confidence",
      "X-Auto-Router-Score",
      "X-Auto-Router-Router-Ms",
      "X-Auto-Router-Worker-Ms",
      "X-Auto-Router-Exploration",
      "X-Auto-Router-Skipped",
    ];
    const merged = new Set(
      expose
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .concat(needed)
    );
    headers.set("Access-Control-Expose-Headers", [...merged].join(", "));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
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
    const data = await response.json();
    return { text: assistantTextFromJson(data), status };
  } catch {
    try {
      const raw = await response.text();
      if (raw.includes("data:")) return { text: textFromSse(raw), status };
      return { text: raw, status };
    } catch {
      return { text: "", status };
    }
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

function extractUsage(data) {
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
