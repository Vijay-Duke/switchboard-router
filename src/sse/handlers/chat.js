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
import { getSettings } from "@/lib/db/index.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { handleAutoChat } from "open-sse/routing/handleAutoChat.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { gateRequireApiKey } from "../utils/requireApiKeyGate.js";
import { hasValidCliToken } from "@/shared/utils/cliToken.js";
import {
  insertRoutingEvent,
  getPromotedLearningVersion,
  getLearningVersionById,
  getClusterWorkerStats,
  getClusterLatencyP50,
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
  if (comboName) {
    invalidateRoutingCache(`stats:${comboName}:`);
    invalidateRoutingCache(`learning:${comboName}`);
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
            signal: opts.signal || null,
          });
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    if (comboStrategy === "auto") {
      const strat = comboStrategies[modelStr] || {};
      // SPEC §2 non-goal: nested combos as router targets
      const routerId = strat.routerModel || "claude/claude-opus-4-8";
      if (await getComboModels(routerId)) {
        log.warn("CHAT", `Auto routerModel is a combo (${routerId}) — rejected`);
        return errorResponse(
          HTTP_STATUS.BAD_REQUEST,
          `routerModel cannot be a combo ("${routerId}"). Use a single provider/model.`
        );
      }
      // Strip nested combos from worker pool (SPEC §2 non-goal)
      const workerModels = [];
      for (const m of comboModels) {
        if (m === routerId) continue;
        if (await getComboModels(m)) {
          log.warn("CHAT", `Auto pool drops nested combo worker "${m}"`);
          continue;
        }
        workerModels.push(m);
      }
      log.info("CHAT", `Combo "${modelStr}" with ${workerModels.length} workers (strategy: auto)`);
      return handleAutoChat({
        body,
        models: [...workerModels, ...(comboModels.includes(routerId) ? [routerId] : [])],
        handleSingleModel: (b, m, callOpts) =>
          handleSingleModelChat(b, m, clientRawRequest, request, apiKey, callOpts),
        log,
        comboName: modelStr,
        strategy: strat,
        loadLearning: loadLearningCached,
        loadStats: loadStatsCached,
        loadClusterP50: (combo, cluster, days) =>
          cached(`p50:${combo}:${cluster}:${days}`, () =>
            getClusterLatencyP50(combo, cluster, days)
          ),
        recordEvent: (ev) => insertRoutingEvent(ev),
        autoDepth: 0,
        clientAbortSignal: request?.signal || null,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const capacityAutoSwitch = comboStrategies[modelStr]?.capacityAutoSwitch !== false;
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
    });
  }

  // Single model request — pass request.signal so abandoned calls abort upstream
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, { signal: request?.signal || null });
}

/**
 * Handle single model chat request
 * @param {object} [callOpts]
 * @param {string} [callOpts.sourceFormatOverride] - Force request format (e.g. router uses "openai")
 * @param {boolean} [callOpts.bypassPromptFilters] - Disable caveman/ponytail/headroom/rtk (router calls)
 * @param {AbortSignal} [callOpts.signal] - Abort upstream on timeout
 * @param {number} [callOpts.autoDepth] - Auto-combo recursion depth
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, callOpts = null) {
  const modelInfo = await getModelInfo(modelStr);
  const autoDepth = callOpts?.autoDepth || 0;

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";

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
              signal: opts.signal || callOpts?.signal || null,
            });
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
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
        const routerId = strat.routerModel || "claude/claude-opus-4-8";
        if (await getComboModels(routerId)) {
          return errorResponse(
            HTTP_STATUS.BAD_REQUEST,
            `routerModel cannot be a combo ("${routerId}")`
          );
        }
        const workerModels = [];
        for (const m of comboModels) {
          if (m === routerId) continue;
          if (await getComboModels(m)) {
            log.warn("CHAT", `Auto pool drops nested combo worker "${m}"`);
            continue;
          }
          workerModels.push(m);
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
            handleSingleModelChat(b, m, clientRawRequest, request, apiKey, opts),
          log,
          comboName: modelStr,
          strategy: strat,
          loadLearning: loadLearningCached,
          loadStats: loadStatsCached,
          loadClusterP50: (combo, cluster, days) =>
            cached(`p50:${combo}:${cluster}:${days}`, () =>
              getClusterLatencyP50(combo, cluster, days)
            ),
          recordEvent: (ev) => insertRoutingEvent(ev),
          autoDepth,
          clientAbortSignal: request?.signal || null,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const capacityAutoSwitch = comboStrategies[modelStr]?.capacityAutoSwitch !== false;
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
