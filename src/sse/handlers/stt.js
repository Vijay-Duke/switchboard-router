import {
  extractApiKey,
  getProviderCredentials, markAccountUnavailable, clearAccountError,
} from "../services/auth.js";
import { getSettings, getCustomModels } from "@/lib/db/index.js";
import { getModelInfo } from "../services/model.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import * as log from "../utils/logger.js";
import { authorizeClientKeyRequest, runWithClientKeyLease } from "../services/clientKeyPolicy.js";
import { withConnectionInFlight } from "../services/connectionInFlight.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";

const CONNECTION_BACKED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth)
    .map(([id]) => id)
);

// Custom-model transport marker: models registered through
// /api/models/custom may pin a specialized STT transport (e.g.
// "gemini-live"). The engine dispatches on the marker itself, so the app
// layer only resolves it — same getModelInfo-style provider+model pairing,
// restricted to type "stt" records.
async function resolveCustomModelTransport(provider, model) {
  try {
    const customModels = await getCustomModels();
    const hit = customModels.find((c) => c && c.type === "stt"
      && c.providerAlias === provider && c.id === model
      && typeof c.transport === "string" && c.transport.trim());
    return hit ? hit.transport.trim() : null;
  } catch {
    return null; // DB unreadable → built-in registry marker still applies
  }
}

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

  // Codex exposes exactly one OAuth transcription model; anything else is a
  // caller mistake, not a missing credential (chat models live on the chat
  // endpoint, and API-key audio providers are separate entries).
  if (provider === "codex" && model !== "transcribe") {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Use model cx/transcribe for Codex STT");
  }

  const modelTransport = await resolveCustomModelTransport(provider, model);

  if (!CONNECTION_BACKED_PROVIDERS.has(provider)) {
    const result = await handleSttCore({ clientKeyId, provider, model, formData, sttConfig: AI_PROVIDERS[provider]?.sttConfig, transport: modelTransport, abortSignal: request.signal });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
  }

  // Stored connections — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    let credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
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
      const isCodex = provider === "codex";
      // Codex STT reuses stored OAuth chat connections: refresh the token
      // with the shared persisted service (same lead/rotation rules as chat)
      // before the audio leaves the process. A refresh failure falls back to
      // the stored token — the forced 401 path below handles a stale one.
      if (isCodex) {
        try {
          credentials = await checkAndRefreshToken(provider, credentials);
        } catch (error) {
          log.warn("AUTH", `Codex STT token refresh failed: ${error?.message || error}`);
        }
      }
      const callCore = (creds) => handleSttCore({
        clientKeyId,
        provider,
        model,
        formData,
        credentials: creds,
        sttConfig: AI_PROVIDERS[provider]?.sttConfig,
        transport: modelTransport,
        abortSignal: request.signal,
      });
      let result = await callCore(credentials);
      // A 401 may simply mean the persisted token rotated elsewhere: one
      // forced refresh + retry, then give up on this connection.
      if (isCodex && !result.success && result.status === 401
        && credentials?.refreshToken && !request.signal.aborted) {
        const previous = credentials.accessToken;
        try {
          credentials = await checkAndRefreshToken(provider, credentials, { force: true });
        } catch (error) {
          log.warn("AUTH", `Codex STT forced token refresh failed: ${error?.message || error}`);
        }
        if (credentials.accessToken !== previous) result = await callCore(credentials);
      }
      if (result.success) {
        if (isCodex) await clearAccountError(credentials.connectionId, credentials, model).catch(() => {});
        return result.response;
      }
      if (result.status === 499 || request.signal.aborted) {
        return { finalResponse: result.response };
      }
      // Bad audio / oversized uploads / conversion timeouts are caller
      // problems, not a broken account — answer without fallback or marking.
      if (isCodex && [400, 413, 504].includes(result.status)) {
        return { finalResponse: result.response || errorResponse(result.status, result.error) };
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
