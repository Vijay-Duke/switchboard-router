import {
  extractApiKey,
  getProviderCredentials, markAccountUnavailable,
} from "../services/auth.js";
import { getSettings } from "@/lib/db/index.js";
import { getModelInfo } from "../services/model.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import * as log from "../utils/logger.js";
import { authorizeClientKeyRequest, runWithClientKeyLease } from "../services/clientKeyPolicy.js";
import { withConnectionInFlight } from "../services/connectionInFlight.js";

// Providers requiring credentials for STT
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleStt(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const modelStr = formData.get("model");
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const strictPreferredConnection = request.headers.get("x-switchboard-strict-connection") === "1";
  log.request("POST", `/v1/audio/transcriptions | ${modelStr}`);

  const settings = await getSettings();
  const auth = await authorizeClientKeyRequest({
    settings,
    rawKey: extractApiKey(request),
    request,
    target: { kind: "model", id: modelStr },
  });
  if (!auth.ok) return auth.response;
  return runWithClientKeyLease(auth.lease, async () => {
    const { clientKeyId } = auth;

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!formData.get("file")) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  // noAuth providers
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleSttCore({ clientKeyId, provider, model, formData, sttConfig: AI_PROVIDERS[provider]?.sttConfig, abortSignal: request.signal });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
  }

  // Credentialed — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId,
      strictPreferredConnection,
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
      const result = await handleSttCore({
        clientKeyId,
        provider,
        model,
        formData,
        credentials,
        sttConfig: AI_PROVIDERS[provider]?.sttConfig,
        abortSignal: request.signal,
      });
      if (result.success) return result.response;
      if (result.status === 499 || request.signal.aborted) {
        return { finalResponse: result.response };
      }

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
  });
}
