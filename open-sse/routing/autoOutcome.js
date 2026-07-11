/**
 * Outcome attribution and response observation for Auto routing.
 * This module owns scoring side effects while handleAutoChat owns policy.
 */
import { computeOutcomeScore } from "./scoring.js";
import { extractUsageFromSseSlice, hasStreamContent, assistantTextFromSseBuffer } from "./autoResponse.js";
import { normalizeCluster } from "./taxonomy.js";

export function observeStreamAndRecord({
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
  judgeCtx = null,
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
          requestId: baseEvent.requestId,
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
    // Non-blocking quality judge on a clean completion (never delays the client;
    // the client stream has already fully flushed by the time finalize runs).
    maybeFireJudge(judgeCtx, baseEvent, workerOk, () => assistantTextFromSseBuffer(buf), log);
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
        requestId: baseEvent.requestId,
        cluster: baseEvent.pick?.cluster,
        confidence: baseEvent.pick?.confidence,
        routerLatencyMs,
        workerLatencyMs: ttfbMs,
        exploration: baseEvent.exploration,
      })
    : out;
}

/**
 * Fire the sampled quality judge without blocking (fail-open). Only runs on a
 * clean completion and when a judge context exists. The text getter is lazy so
 * we don't extract when judging is off.
 */
function maybeFireJudge(judgeCtx, baseEvent, workerOk, getText, log) {
  if (!judgeCtx || !workerOk || !judgeCtx.shouldSample()) return;
  try {
    const assistantText = getText() || "";
    if (!assistantText) return;
    Promise.resolve(judgeCtx.runJudge({ baseEvent, assistantText })).catch((e) =>
      log?.warn?.("AUTO", `judge dispatch failed: ${e?.message || e}`)
    );
  } catch (e) {
    log?.warn?.("AUTO", `judge dispatch failed: ${e?.message || e}`);
  }
}

/**
 * Write bandit-attribution rows for failed workers in a chain.
 * When allFailed, only the last attempt is terminal (request-level count = 1).
 * When partial, every failure is non-terminal; winner is recorded separately as terminal.
 */
export function flushFailureEvents({
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

export function fireRecordEvent(recordEvent, log, args) {
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
  // Confidence-neutral by design (see computeOutcomeScore) — confidence stays in
  // event meta below for telemetry, never in the stored outcome score.
  // scoreInputs are persisted so the judge / feedback path can recompute the
  // exact score after folding in a ±25 rating (see recomputeStoredOutcome).
  const scoreInputs = {
    workerOk: !!workerOk,
    workerLatencyMs: workerLatencyMs ?? null,
    clusterP50LatencyMs: clusterP50LatencyMs ?? null,
    fallbackUsed: !!fallbackUsed,
    retries: retries ?? 0,
    hasCompletion: !!hasCompletion,
    tokensOut: tokensOut ?? null,
  };
  const outcomeScore = computeOutcomeScore(scoreInputs);

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
      // Auto v2: store the canonical taxonomy cluster (router output is already
      // normalized; this also folds "unknown" parse-error fallbacks → "general").
      cluster: normalizeCluster(pick.cluster),
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
        // Full input set + base score so judge/feedback can recompute exactly.
        scoreInputs,
        baseOutcomeScore: outcomeScore,
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
export function withAutoRouterHeaders(response, meta) {
  if (!response) return response;
  try {
    const headers = new Headers(response.headers);
    if (meta.worker) headers.set("X-Auto-Router-Worker", String(meta.worker));
    // Feedback endpoint correlation: client integrations POST this back with a rating.
    if (meta.requestId) headers.set("X-Auto-Router-Request-Id", String(meta.requestId));
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
      "X-Auto-Router-Request-Id",
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
