import "open-sse/index.js";
import "../initOpenSseDeps.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettings, getUsageStats } from "@/lib/db/index.js";
import { getProviderQuotaHeadroom } from "@/lib/db/repos/connectionsRepo.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { handleAutoChat, invalidateCachedRoutes } from "open-sse/routing/handleAutoChat.js";
import { resetOverlay } from "open-sse/routing/overlay.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS, MAX_COMBO_DEPTH } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { injectVaultTool, repairInboundVaultResults, runVaultLoop } from "open-sse/rtk/vaultLoop.js";
import {
  hashKey,
  conversationFingerprint,
  conversationInfo,
  vaultConversationId,
  messagesMentionAsk,
  matchPendingAsk,
  consumePendingAsk,
  recordAskAnswered,
  recordAskIgnored,
  parseRatingReply,
  ratingFromReply,
  stripAskExchange,
  hasPendingAsks,
} from "open-sse/routing/feedbackAsk.js";
import * as log from "../utils/logger.js";
import { applyRatingSideEffects } from "../routing/ratingSideEffects.js";
import { resolveWorkerCaps } from "../routing/comboCaps.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { gateRequireApiKey } from "../utils/requireApiKeyGate.js";
import { hasValidCliToken } from "@/shared/utils/cliToken.js";
import {
  insertRoutingEvent,
  applyJudgeScoreByRequestId,
  setUserRatingByRequestId,
  getPromotedLearningVersion,
  getLearningVersionById,
  getClusterWorkerStats,
  getGlobalModelStats,
  getClusterLatencyP50,
  getProviderLatency,
  setRoutingWriteHook,
} from "@/lib/db/repos/routingRepo.js";
import {
  cached,
  invalidateRoutingCache,
  statsCacheKey,
  learningCacheKey,
} from "open-sse/routing/routingCache.js";

// Hot-path cache invalidation when routing events / learning versions change
setRoutingWriteHook((comboName) => {
  resetOverlay(comboName);
  if (comboName) {
    invalidateRoutingCache(`stats:${comboName}:`);
    invalidateRoutingCache(`learning:${comboName}`);
    // Learning promotion / rollback changes the bandit — drop cached router picks
    // for this combo so the next request re-routes against the new policy.
    invalidateCachedRoutes(comboName);
  } else {
    invalidateRoutingCache();
  }
});

/**
 * Load learning artifacts: activeLearningVersionId pin wins over promoted.
 * @param {string} name
 * @param {object} [strategy]
 */
async function loadLearningCached(name, strategy = {}) {
  const pin = strategy?.activeLearningVersionId;
  if (pin) {
    return cached(`learning:id:${pin}`, () => getLearningVersionById(pin));
  }
  return cached(learningCacheKey(name), () => getPromotedLearningVersion(name));
}

async function loadStatsCached(name, days = 14) {
  const d = Math.min(90, Math.max(1, Number(days) || 14));
  return cached(statsCacheKey(name, d), () => getClusterWorkerStats(name, d));
}

async function loadProviderLatency(days) {
  try {
    const latency = await cached(`provlat:${days}`, () => getProviderLatency(days), 15000);
    return latency && typeof latency === "object" ? latency : {};
  } catch {
    return {};
  }
}

async function loadProviderUsage() {
  try {
    const usage = await getUsageStats("7d");
    const providerUsage = {};
    for (const [provider, stats] of Object.entries(usage?.byProvider || {})) {
      providerUsage[provider] = Number.isFinite(stats?.requests) ? stats.requests : 0;
    }
    return providerUsage;
  } catch {
    return {};
  }
}

async function loadProviderQuota() {
  try {
    const providerQuota = await getProviderQuotaHeadroom();
    return providerQuota && typeof providerQuota === "object" ? providerQuota : {};
  } catch {
    return {};
  }
}

async function loadProviderPreference(strategy) {
  const [providerLatencyMs, providerUsage] = await Promise.all([
    loadProviderLatency(14),
    loadProviderUsage(),
  ]);
  const providerQuota = strategy.providerStrategy === "quota-first"
    ? await loadProviderQuota()
    : {};
  return {
    providerStrategy: strategy.providerStrategy,
    providerOrder: Array.isArray(strategy.providerOrder) ? strategy.providerOrder : [],
    providerLatencyMs,
    providerUsage,
    providerQuota,
    providerLatencyGuardMs: strategy.providerLatencyGuardMs,
  };
}

function cannedThanksResponse(stream, modelStr) {
  const now = Date.now();
  const id = `chatcmpl-fb-${now}`;
  const created = Math.floor(now / 1000);

  if (!stream) {
    return new Response(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model: modelStr,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Thanks — noted." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();
  const chunk = (choices) => ({ id, object: "chat.completion.chunk", created, model: modelStr, choices });
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]))}\n\n`)
      );
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(chunk([{ index: 0, delta: { content: "Thanks — noted." }, finish_reason: null }]))}\n\n`)
      );
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]))}\n\n`)
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    log.warn("CHAT", "Invalid JSON body shape");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  // Log request endpoint and model
  const url = new URL(request.url);
  const modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings (L3 shared gate)
  const settings = await getSettings();
  const denied = await gateRequireApiKey(settings, apiKey, {
    isValidApiKey, log, errorResponse, HTTP_STATUS, request, hasValidCliToken,
  });
  if (denied) return denied;

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // Dynamic in-chat feedback: capture a 1/2/3 reply, strip the synthetic exchange.
  // OpenAI chat-completions wire only; fully fail-open.
  try {
    // Fast path: skip all hashing/scanning unless the feature is actually live —
    // an ask is outstanding OR this history carries the synthetic ask line.
    const mentionsAsk =
      Array.isArray(body.messages) && body.messages.length
        ? messagesMentionAsk(body.messages)
        : false;
    if ((hasPendingAsks() || mentionsAsk) && Array.isArray(body.messages) && body.messages.length) {
      const wire = detectFormatByEndpoint(new URL(request.url).pathname, body);
      const isOpenAiWire = wire === "openai";
      const apiKeyHash = hashKey(apiKey);
      const info = conversationInfo(body.messages);
      const conversationFp = conversationFingerprint(info.firstUserText, apiKeyHash);
      const pending = isOpenAiWire ? matchPendingAsk(apiKeyHash, conversationFp) : null;
      if (pending) {
        const rating = info.priorAssistantHasAsk ? parseRatingReply(info.latestUserText) : null;
        if (rating != null) {
          const mapped = ratingFromReply(rating);
          try {
            await setUserRatingByRequestId(pending.requestId, mapped);
            await applyRatingSideEffects(pending.requestId, mapped);
          } catch {
            /* fail-open */
          }
          consumePendingAsk(apiKeyHash, conversationFp);
          recordAskAnswered(apiKeyHash);
          log.info?.("FEEDBACK", `captured rating ${mapped} for ${pending.requestId}`);
          return cannedThanksResponse(!!body.stream, modelStr);
        }
        // A pending ask exists but the user moved on without rating -> count as ignored.
        recordAskIgnored(apiKeyHash);
        consumePendingAsk(apiKeyHash, conversationFp);
      }
      // Upstream must never see the ask exchange (strip on any messages[] defensively).
      if (mentionsAsk) {
        body.messages = stripAskExchange(body.messages);
      }
    }
  } catch (e) {
    log.warn?.("FEEDBACK", `capture/strip failed (ignored): ${e?.message || e}`);
  }

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, panelOpts) => {
          const opts = panelOpts === true ? { isPanel: true } : (panelOpts || {});
          let cleanRawReq = clientRawRequest;
          if (opts.isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, {
            ...opts,
            signal: opts.signal || null,
          });
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
        abortSignal: request?.signal || null,
        childComboDepth: 1,
      });
    }

    if (comboStrategy === "auto") {
      const strat = comboStrategies[modelStr] || {};
      const fbEnabled = strat.feedbackAsk === true;
      let feedbackCtx = null;
      if (fbEnabled) {
        try {
          const wire = detectFormatByEndpoint(new URL(request.url).pathname, body);
          const info = conversationInfo(body.messages);
          const apiKeyHash = hashKey(apiKey);
          feedbackCtx = {
            apiKeyHash,
            conversationFp: conversationFingerprint(info.firstUserText, apiKeyHash),
            openAiWire: wire === "openai",
            gateOk:
              !((body.tools && body.tools.length) || (body.functions && body.functions.length)) &&
              Number(info.userTurns) >= 2,
            feedbackAsk: true,
          };
        } catch {
          feedbackCtx = null;
        }
      }
      // routerModel is mandatory for Auto combos (no default). handleAutoChat is
      // the authoritative guard; here we only avoid a nested-combo router target.
      const routerId = strat.routerModel;
      if (routerId && (await getComboModels(routerId))) {
        log.warn("CHAT", `Auto routerModel is a combo (${routerId}) — rejected`);
        return errorResponse(
          HTTP_STATUS.BAD_REQUEST,
          `routerModel cannot be a combo ("${routerId}"). Use a single provider/model.`
        );
      }
      const workerModels = [];
      for (const m of comboModels) {
        if (m === routerId) continue;
        workerModels.push(m);
      }
      const workerCaps = {};
      for (const m of workerModels) {
        try {
          workerCaps[m] = await resolveWorkerCaps(m);
        } catch {
          workerCaps[m] = {};
        }
      }
      log.info("CHAT", `Combo "${modelStr}" with ${workerModels.length} workers (strategy: auto)`);
      return handleAutoChat({
        body,
        models: [...workerModels, ...(comboModels.includes(routerId) ? [routerId] : [])],
        handleSingleModel: (b, m, callOpts) =>
          handleSingleModelChat(b, m, clientRawRequest, request, apiKey, {
            ...(callOpts || {}),
            comboDepth: 0,
          }),
        log,
        comboName: modelStr,
        strategy: strat,
        loadLearning: loadLearningCached,
        loadStats: loadStatsCached,
        loadGlobalStats: (days) =>
          cached(`gstats:${days}`, () => getGlobalModelStats(days), 15000),
        loadClusterP50: (combo, cluster, days) =>
          cached(`p50:${combo}:${cluster}:${days}`, () =>
            getClusterLatencyP50(combo, cluster, days)
          ),
        loadProviderLatency,
        loadProviderUsage,
        loadProviderQuota,
        recordEvent: (ev) => insertRoutingEvent(ev),
        applyJudgeScore: (requestId, judgeScore) =>
          applyJudgeScoreByRequestId(requestId, judgeScore),
        autoDepth: 0,
        clientAbortSignal: request?.signal || null,
        feedbackCtx,
        workerCaps,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const ps = comboStrategies[modelStr] || {};
    const capacityAutoSwitch = ps.capacityAutoSwitch !== false;
    const providerPreference = ps.providerStrategy && ps.providerStrategy !== "off"
      ? await loadProviderPreference(ps)
      : null;
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit}, capacitySwitch: ${capacityAutoSwitch})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m, callOpts) =>
        handleSingleModelChat(b, m, clientRawRequest, request, apiKey, callOpts),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      autoSwitch: capacityAutoSwitch,
      ...(providerPreference || {}),
      abortSignal: request?.signal || null,
      childComboDepth: 1,
    });
  }

  // Single model request — vault retrieval is deliberately scoped here, never combos/Auto.
  let wire = null;
  try {
    wire = detectFormatByEndpoint(new URL(request.url).pathname, body);
  } catch {}
  const vaultActive = !!(settings.tokenSaver?.vault) && Array.isArray(body.tools) && body.tools.length > 0 && (wire === "openai" || wire === "claude");
  if (!vaultActive) {
    return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, { signal: request?.signal || null });
  }

  try {
    const conversationId = vaultConversationId(body.messages, hashKey(apiKey));
    if (!conversationId) {
      return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, { signal: request?.signal || null });
    }
    await repairInboundVaultResults(body, { conversationId });
    injectVaultTool(body, wire);
    const searchLimit = Number(settings.tokenSaver?.vaultSearchLimit ?? 5);
    return await runVaultLoop({
      dispatch: (currentBody, options) => handleSingleModelChat(
        currentBody,
        modelStr,
        clientRawRequest,
        request,
        apiKey,
        { signal: request?.signal || null, vaultInternal: !!options?.vaultInternal, vaultStore: true, vaultConversationId: conversationId },
      ),
      body,
      wire,
      conversationId,
      searchLimit,
      log,
    });
  } catch {
    return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, { signal: request?.signal || null });
  }
}

/**
 * Handle single model chat request
 * @param {object} [callOpts]
 * @param {string} [callOpts.sourceFormatOverride] - Force request format (e.g. router uses "openai")
 * @param {boolean} [callOpts.bypassPromptFilters] - Disable caveman/ponytail/headroom/rtk (router calls)
 * @param {boolean} [callOpts.bypassNativePassthrough] - Force internal router bodies through translation
 * @param {AbortSignal} [callOpts.signal] - Abort upstream on timeout
 * @param {number} [callOpts.autoDepth] - Auto-combo recursion depth
 * @param {number} [callOpts.comboDepth] - Fallback/round-robin/fusion combo recursion depth
 * @param {boolean} [callOpts.vaultInternal] - Suppress duplicate client request-log rows
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, callOpts = null) {
  const modelInfo = await getModelInfo(modelStr);
  const autoDepth = callOpts?.autoDepth || 0;
  const comboDepth = callOpts?.comboDepth || 0;

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";

      if (comboStrategy !== "auto" && comboDepth >= MAX_COMBO_DEPTH) {
        log.warn("CHAT", `Combo nesting limit at "${modelStr}" (depth ${comboDepth})`);
        return errorResponse(
          HTTP_STATUS.BAD_REQUEST,
          `Combo nesting too deep (>${MAX_COMBO_DEPTH}) at "${modelStr}"`
        );
      }

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, panelOpts) => {
            const opts = panelOpts === true ? { isPanel: true } : (panelOpts || {});
            let cleanRawReq = clientRawRequest;
            if (opts.isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, {
              ...(callOpts || {}),
              ...opts,
              signal: opts.signal || callOpts?.signal || null,
            });
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
          abortSignal: request?.signal || callOpts?.signal || null,
          childComboDepth: comboDepth + 1,
        });
      }

      if (comboStrategy === "auto") {
        if (autoDepth >= 2) {
          log.warn("CHAT", `Auto combo recursion limit at "${modelStr}" (depth ${autoDepth})`);
          return errorResponse(
            HTTP_STATUS.BAD_REQUEST,
            `Auto combo recursion limit — "${modelStr}" cannot nest further`
          );
        }
        const strat = comboStrategies[modelStr] || {};
        const fbEnabled = strat.feedbackAsk === true;
        let feedbackCtx = null;
        if (fbEnabled) {
          try {
            const wire = detectFormatByEndpoint(new URL(request.url).pathname, body);
            const info = conversationInfo(body.messages);
            const apiKeyHash = hashKey(apiKey);
            feedbackCtx = {
              apiKeyHash,
              conversationFp: conversationFingerprint(info.firstUserText, apiKeyHash),
              openAiWire: wire === "openai",
              gateOk:
                !((body.tools && body.tools.length) || (body.functions && body.functions.length)) &&
                Number(info.userTurns) >= 2,
              feedbackAsk: true,
            };
          } catch {
            feedbackCtx = null;
          }
        }
        // routerModel is mandatory (no default); handleAutoChat rejects if absent.
        const routerId = strat.routerModel;
        if (routerId && (await getComboModels(routerId))) {
          return errorResponse(
            HTTP_STATUS.BAD_REQUEST,
            `routerModel cannot be a combo ("${routerId}")`
          );
        }
        const workerModels = [];
        for (const m of comboModels) {
          if (m === routerId) continue;
          workerModels.push(m);
        }
        const workerCaps = {};
        for (const m of workerModels) {
          try {
            workerCaps[m] = await resolveWorkerCaps(m);
          } catch {
            workerCaps[m] = {};
          }
        }
        log.info(
          "CHAT",
          `Combo "${modelStr}" with ${workerModels.length} workers (strategy: auto, depth=${autoDepth})`
        );
        return handleAutoChat({
          body,
          models: [
            ...workerModels,
            ...(comboModels.includes(routerId) ? [routerId] : []),
          ],
          handleSingleModel: (b, m, opts) =>
            handleSingleModelChat(b, m, clientRawRequest, request, apiKey, {
              ...(opts || {}),
              comboDepth,
            }),
          log,
          comboName: modelStr,
          strategy: strat,
          loadLearning: loadLearningCached,
          loadStats: loadStatsCached,
          loadGlobalStats: (days) =>
            cached(`gstats:${days}`, () => getGlobalModelStats(days), 15000),
          loadClusterP50: (combo, cluster, days) =>
            cached(`p50:${combo}:${cluster}:${days}`, () =>
              getClusterLatencyP50(combo, cluster, days)
            ),
          loadProviderLatency,
          loadProviderUsage,
          loadProviderQuota,
          recordEvent: (ev) => insertRoutingEvent(ev),
          applyJudgeScore: (requestId, judgeScore) =>
            applyJudgeScoreByRequestId(requestId, judgeScore),
          autoDepth,
          clientAbortSignal: request?.signal || null,
          feedbackCtx,
          workerCaps,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const ps = comboStrategies[modelStr] || {};
      const capacityAutoSwitch = ps.capacityAutoSwitch !== false;
      const providerPreference = ps.providerStrategy && ps.providerStrategy !== "off"
        ? await loadProviderPreference(ps)
        : null;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit}, capacitySwitch: ${capacityAutoSwitch})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, opts) =>
          handleSingleModelChat(b, m, clientRawRequest, request, apiKey, opts),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        autoSwitch: capacityAutoSwitch,
        ...(providerPreference || {}),
        abortSignal: request?.signal || callOpts?.signal || null,
        childComboDepth: comboDepth + 1,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Log model routing (alias → actual model)
  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Log account selection
    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore — deep-clone body so account retries don't share
    // modality/tool mutations from a prior attempt (wave12).
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const attemptBody = typeof structuredClone === "function"
      ? structuredClone(body)
      : JSON.parse(JSON.stringify(body));
    // Prefer explicit override (router always OpenAI shape); else detect from endpoint
    const sourceFormatOverride =
      callOpts?.sourceFormatOverride ||
      (request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null);

    // Router / internal JSON-only calls must not get style/compression rewrites
    const bypassFilters = !!callOpts?.bypassPromptFilters;

    const result = await handleChatCore({
      body: { ...attemptBody, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: bypassFilters ? false : !!chatSettings.rtkEnabled,
      // Store is scoped to the single-model vault loop, which is the only path
      // that injects sb_vault_search. Combos/Auto/fusion members reach here too
      // but never inject, so vaulting there would strand the model with
      // un-retrievable pointers — gate on the loop-set vaultStore flag.
      vaultEnabled: (bypassFilters || !callOpts?.vaultStore) ? false : !!(chatSettings.tokenSaver?.vault),
      vaultThresholdKB: chatSettings.tokenSaver?.vaultThresholdKB ?? 8,
      vaultTtlHours: chatSettings.tokenSaver?.vaultTtlHours ?? 24,
      // Single source of truth for the vault scope key: derived in the vault loop
      // from the SOURCE body and threaded through here. chatCore never re-derives.
      vaultConversationId: callOpts?.vaultConversationId ?? null,
      headroomEnabled: bypassFilters ? false : !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: bypassFilters
        ? false
        : !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: bypassFilters ? false : !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: bypassFilters ? false : !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      providerThinking,
      sourceFormatOverride,
      bypassNativePassthrough: !!callOpts?.bypassNativePassthrough,
      vaultInternal: !!callOpts?.vaultInternal,
      abortSignal: callOpts?.signal || null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
      // Antigravity empty-stream exhaustion: bench this account so the client's
      // next retry (or outer account loop) can rotate. Switchboard PR#2462.
      onUpstreamEmptyExhausted: async (errMsg, resetsAtMs) => {
        await markAccountUnavailable(
          credentials.connectionId,
          502,
          typeof errMsg === "string" ? errMsg : (errMsg?.message || "empty stream"),
          provider,
          model,
          resetsAtMs
        );
      },
    });

    if (result.success) return result.response;

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
