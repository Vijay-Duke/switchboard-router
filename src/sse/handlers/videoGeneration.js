import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/db/index.js";
import { getModelInfo } from "../services/model.js";
import { handleVideoProxyCore, getVideoConfig, sanitizeSecrets } from "open-sse/handlers/videoCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import * as log from "../utils/logger.js";
import { authorizeClientKeyRequest, runWithClientKeyLease } from "../services/clientKeyPolicy.js";
import { withConnectionInFlight } from "../services/connectionInFlight.js";

// Video generation is xAI-only today; requests without a provider prefix
// (bare model id, or multipart bodies we deliberately don't parse) land here.
const DEFAULT_VIDEO_PROVIDER = "xai";

// Creation POSTs are billable jobs — only rotate to another account for
// errors that upstream rejects BEFORE creating a job (auth/quota). A 5xx may
// have created the job, so it is returned to the caller instead of re-sent.
const CREATE_ROTATION_STATUSES = new Set([
  HTTP_STATUS.UNAUTHORIZED,
  HTTP_STATUS.FORBIDDEN,
  HTTP_STATUS.RATE_LIMITED,
]);

async function authorizeVideoRequest(request) {
  const settings = await getSettings();
  return authorizeClientKeyRequest({
    settings,
    rawKey: extractApiKey(request),
    request,
    target: { kind: "model", id: null },
  });
}

/**
 * Read the request body once, byte-preserving.
 * JSON bodies are additionally parsed so the `model` provider prefix can be
 * resolved (and stripped) — everything else is forwarded exactly as received.
 */
async function readForwardableBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const raw = await request.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
    }
    return { raw, parsed, contentType };
  }
  // Multipart (or any other content type): forward the exact bytes — parsing
  // and re-encoding FormData would change the multipart boundary.
  const buf = Buffer.from(await request.arrayBuffer());
  return { raw: buf, parsed: null, contentType };
}

async function resolveVideoProvider(parsedBody) {
  if (!parsedBody?.model) return { provider: DEFAULT_VIDEO_PROVIDER, model: null };

  const modelStr = String(parsedBody.model);
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Combos are not supported for video generation") };
  }
  if (!getVideoConfig(modelInfo.provider)) {
    // Bare model ids (no explicit "provider/" prefix) fall back to the default
    // video provider — the prefix-less inference targets chat providers only.
    if (!modelStr.includes("/")) {
      return { provider: DEFAULT_VIDEO_PROVIDER, model: modelStr };
    }
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider '${modelInfo.provider}' does not support video generation`) };
  }
  return { provider: modelInfo.provider, model: modelInfo.model };
}

function withConnectionHeader(response, connectionId) {
  if (!connectionId) return response;
  const headers = new Headers(response.headers);
  // Video jobs are account-bound upstream — clients echo this back as
  // `x-connection-id` on GET polls so the same account is used.
  headers.set("x-switchboard-connection-id", String(connectionId));
  return new Response(response.body, { status: response.status, headers });
}

/**
 * POST /v1/videos/{generations|edits|extensions} — async job creation proxy.
 */
export async function handleVideoCreate(request, action) {
  const auth = await authorizeVideoRequest(request);
  if (!auth.ok) return auth.response;

  return runWithClientKeyLease(auth.lease, async () => {
    const bodyInfo = await readForwardableBody(request);
    if (bodyInfo.error) return bodyInfo.error;

    const resolved = await resolveVideoProvider(bodyInfo.parsed);
    if (resolved.error) return resolved.error;
    const { provider, model } = resolved;

    // Strip the provider prefix (e.g. "xai/grok-imagine-video") before forwarding;
    // otherwise forward the original bytes untouched.
    let forwardBody = bodyInfo.raw;
    if (bodyInfo.parsed && model && bodyInfo.parsed.model !== model) {
      forwardBody = JSON.stringify({ ...bodyInfo.parsed, model });
    }

    const preferredConnectionId = request.headers.get("x-connection-id") || null;
    const strictPreferredConnection = request.headers.get("x-switchboard-strict-connection") === "1";
    const idempotencyKey = request.headers.get("idempotency-key") || null;
    const { clientKeyId } = auth;

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
          const errorMsg = lastError || credentials.lastError || "Unavailable";
          const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
          return unavailableResponse(status, `[${provider}/${model || "video"}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
        }
        if (excludeConnectionIds.size === 0) {
          return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
        }
        return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
      }

      const attempt = await withConnectionInFlight({
        provider,
        model,
        connectionId: credentials.connectionId,
      }, async () => {
        const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

        const result = await handleVideoProxyCore({
          provider,
          action,
          rawBody: forwardBody,
          contentType: bodyInfo.contentType || null,
          idempotencyKey,
          credentials: refreshedCredentials,
          signal: request.signal,
          log,
          onCredentialsRefreshed: async (newCreds) => {
            await updateProviderCredentials(credentials.connectionId, {
              accessToken: newCreds.accessToken,
              refreshToken: newCreds.refreshToken,
              providerSpecificData: newCreds.providerSpecificData,
              testStatus: "active",
            });
          },
        });

        if (result.success) {
          await clearAccountError(credentials.connectionId, credentials, model);
          log.info("VIDEO", `${provider.toUpperCase()} | ${action} accepted (connection ${credentials.connectionId})`);
          return { finalResponse: withConnectionHeader(result.response, credentials.connectionId) };
        }

        // Record the failure (dashboard shows lastError/errorCode → user sees re-auth is needed)
        const { shouldFallback } = await markAccountUnavailable(
          credentials.connectionId, result.status, sanitizeSecrets(result.error, refreshedCredentials), provider, model
        );

        if (shouldFallback && CREATE_ROTATION_STATUSES.has(result.status)) {
          return { retry: true, error: result.error, status: result.status };
        }
        return { finalResponse: result.response };
      });

      if (attempt.finalResponse) return attempt.finalResponse;
      excludeConnectionIds.add(credentials.connectionId);
      lastError = attempt.error;
      lastStatus = attempt.status;
    }
  });
}

/**
 * GET /v1/videos/{request_id} — poll job status.
 * Jobs are account-bound upstream, so no cross-account rotation here: the
 * caller pins the creating account via `x-connection-id` (returned on create).
 */
export async function handleVideoGet(request, requestId) {
  const auth = await authorizeVideoRequest(request);
  if (!auth.ok) return auth.response;

  return runWithClientKeyLease(auth.lease, async () => {
    if (!requestId) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing video request id");

    const provider = DEFAULT_VIDEO_PROVIDER;
    const preferredConnectionId = request.headers.get("x-connection-id") || null;
    const { clientKeyId } = auth;

    const credentials = await getProviderCredentials(provider, null, null, {
      preferredConnectionId,
      clientKeyId,
    });
    if (!credentials || credentials.allRateLimited) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleVideoProxyCore({
      provider,
      requestId,
      credentials: refreshedCredentials,
      signal: request.signal,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active",
        });
      },
    });

    if (result.success) {
      await clearAccountError(credentials.connectionId, credentials, null);
      return withConnectionHeader(result.response, credentials.connectionId);
    }

    await markAccountUnavailable(
      credentials.connectionId, result.status, sanitizeSecrets(result.error, refreshedCredentials), provider, null
    );
    return result.response;
  });
}
