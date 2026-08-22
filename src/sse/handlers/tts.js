import {
  extractApiKey,
  getProviderCredentials, markAccountUnavailable,
} from "../services/auth.js";
import { getSettings } from "@/lib/db/index.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { authorizeClientKeyRequest, runWithClientKeyLease } from "../services/clientKeyPolicy.js";
import { withConnectionInFlight } from "../services/connectionInFlight.js";

// Derived from providers.js: any TTS provider not noAuth requires stored credentials
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("tts") && !p.noAuth && p.ttsConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleTts(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;
  const responseFormat = url.searchParams.get("response_format") || "mp3"; // mp3 (default) | json
  const language = body.language || ""; // Optional language hint (currently used by Gemini)
  log.request("POST", `${url.pathname} | ${modelStr} | format=${responseFormat}${language ? ` | lang=${language}` : ""}`);

  const settings = await getSettings();
  const comboModels = modelStr ? await getComboModels(modelStr) : null;
  const auth = await authorizeClientKeyRequest({
    settings,
    rawKey: extractApiKey(request),
    request,
    target: { kind: comboModels ? "combo" : "model", id: modelStr },
  });
  if (!auth.ok) return auth.response;
  return runWithClientKeyLease(auth.lease, async () => {
    const { clientKeyId } = auth;

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.input) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("TTS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      handleSingleModel: (b, m, callOpts) => handleSingleModelTts(b, m, responseFormat, language, clientKeyId, callOpts?.signal),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      abortSignal: request?.signal || null,
    });
  }

  return handleSingleModelTts(body, modelStr, responseFormat, language, clientKeyId, request?.signal || null);
  });
}

async function handleSingleModelTts(body, modelStr, responseFormat, language, clientKeyId, abortSignal = null) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Voice: ${model}`);

  // noAuth providers — no credential needed
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleTtsCore({ clientKeyId, provider, model, input: body.input, responseFormat, language, abortSignal });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  // Credentialed providers — fallback loop (same pattern as embeddings)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      clientKeyId,
    });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const attempt = await withConnectionInFlight({
      provider,
      model,
      connectionId: credentials.connectionId,
    }, async () => {
      const result = await handleTtsCore({
        clientKeyId,
        provider,
        model,
        input: body.input,
        credentials,
        responseFormat,
        language,
        abortSignal,
      });
      if (result.success) return result.response;

      const { shouldFallback } = await markAccountUnavailable(
        credentials.connectionId,
        result.status,
        result.error,
        provider,
        model,
      );
      if (shouldFallback) {
        return { retry: true, error: result.error, status: result.status };
      }
      return {
        finalResponse: result.response || errorResponse(result.status, result.error),
      };
    });

    if (attempt instanceof Response) return attempt;
    if (attempt.finalResponse) return attempt.finalResponse;
    excludeConnectionIds.add(credentials.connectionId);
    lastError = attempt.error;
    lastStatus = attempt.status;
  }
}
