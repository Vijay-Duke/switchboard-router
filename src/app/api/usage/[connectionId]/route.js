// @ts-check
// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";
import "@/sse/initQuotaStateDeps.js";

import { getProviderConnectionById, updateProviderConnectionCredentialsIfCurrent } from "@/lib/db/index.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";
import { withCredentialRefreshLock, getProviderSpecificRefreshUpdates, getCredentialRefreshReceipt } from "open-sse/services/oauthCredentialManager.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Refresh credentials using executor and update database
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed: boolean }>
 */
export async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  // Usage pages and auto-ping can hold a snapshot while chat or a background
  // refresh rotates the account. Never replay that snapshot's consumed token.
  const stored = await getProviderConnectionById(connection.id);
  if (!stored) throw new Error("Connection no longer available");
  const alreadyRotated = ["accessToken", "refreshToken", "idToken"].some(key =>
    (stored[key] ?? null) !== (connection[key] ?? null))
    || ["copilotToken", "copilotTokenExpiresAt"].some(key =>
      (stored.providerSpecificData?.[key] ?? null) !== (connection.providerSpecificData?.[key] ?? null));
  const accountChanged = stored.provider !== connection.provider || stored.authType !== connection.authType;
  connection = stored;
  if (accountChanged) return { connection, refreshed: false };
  if (alreadyRotated && connection.accessToken) return { connection, refreshed: false };
  const executor = getExecutor(connection.provider);

  // Build credentials object from connection
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  // Check if refresh is needed (skip when force=true)
  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  // Use executor's refreshCredentials method (with optional proxy)
  const refreshResult = await withCredentialRefreshLock(
    connection.provider, credentials,
    () => executor.refreshCredentials(credentials, console, proxyOptions),
  );

  if (!refreshResult || refreshResult.error) {
    // A sibling writer may have succeeded while this attempt was refused.
    // Reload rather than returning or persisting the older token snapshot.
    const latest = await getProviderConnectionById(connection.id);
    if (latest?.accessToken) return { connection: latest, refreshed: false };
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  // Build update object
  const now = new Date().toISOString();
  const updateData = {
    updatedAt: now,
  };

  // Update accessToken if present
  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }

  // Update refreshToken if present
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }

  if (refreshResult.idToken) {
    updateData.idToken = refreshResult.idToken;
  }

  if (refreshResult.lastRefreshAt) {
    updateData.lastRefreshAt = refreshResult.lastRefreshAt;
  }

  // Update token expiry
  const receipt = getCredentialRefreshReceipt(connection.id, refreshResult);
  const issuedExpiry = receipt?.expiresAt
    ?? (refreshResult.expiresAt ? new Date(refreshResult.expiresAt).getTime() : null);
  if (Number.isFinite(issuedExpiry)) {
    updateData.expiresAt = new Date(issuedExpiry).toISOString();
    updateData.expiresIn = Math.max(0, Math.ceil((issuedExpiry - Date.now()) / 1000));
  } else if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
    updateData.expiresIn = refreshResult.expiresIn;
  }

  // Handle provider-specific data (copilotToken for GitHub, etc.)
  const providerSpecificUpdates = {
    // Shared refresh callers can return metadata merged with their old
    // snapshot. Persist only changed fields, preserving newer operator config.
    ...Object.fromEntries(Object.entries(getProviderSpecificRefreshUpdates(refreshResult))
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(connection.providerSpecificData?.[key]))),
    ...(refreshResult.copilotToken ? { copilotToken: refreshResult.copilotToken } : {}),
    ...(refreshResult.copilotTokenExpiresAt ? { copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt } : {}),
  };
  if (Object.keys(providerSpecificUpdates).length > 0) {
    updateData.providerSpecificData = providerSpecificUpdates;
  }

  // Reject late results if another writer has already rotated this account.
  const updatedConnection = await updateProviderConnectionCredentialsIfCurrent(
    connection.id, connection, updateData,
  );
  if (!updatedConnection) {
    const latest = await getProviderConnectionById(connection.id);
    if (latest?.accessToken) return { connection: latest, refreshed: false };
    throw new Error("Connection no longer available");
  }
  return { connection: updatedConnection, refreshed: true };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    if (!connectionId || typeof connectionId !== "string" || connectionId.length > 200) {
      return Response.json({ error: "Invalid connection id" }, { status: 400 });
    }
    // ?force=1 bypasses the client-side Claude quota cache (manual refresh button)
    const force = new URL(request.url).searchParams.get("force") === "1";
    // Get connection from database
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    // Allow OAuth connections, plus whitelisted apikey providers (glm/minimax/kiro/...)
    // Kiro's headless api-key flow persists authType "api_key" (underscore) while
    // generic apikey providers persist "apikey" — accept both spellings here.
    const isOAuth = connection.authType === "oauth";
    const isApikeyAuth =
      connection.authType === "apikey" || connection.authType === "api_key";
    const isApikeyEligible =
      isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);

    if (!isOAuth && !isApikeyEligible) {
      return Response.json({ error: "Usage not available for this connection" }, { status: 400 });
    }

    // Resolve connection proxy config; force strictProxy=false so quota/refresh fall back to direct on failure
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    // Refresh credentials only for OAuth connections (apikey has no token refresh)
    if (isOAuth) {
      try {
        const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
        connection = result.connection;
      } catch (refreshError) {
        console.error("[Usage API] Credential refresh failed:", refreshError);
        return Response.json({
          error: "Credential refresh failed. Please re-authorize the connection."
        }, { status: 401 });
      }
    }

    // Fetch usage from provider API
    let usage = await getUsageForProvider(connection, proxyOptions, { force });

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once (OAuth only)
    if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, proxyOptions, { force });
      } catch (retryError) {
        console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
      }
    }

    return Response.json(usage, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return Response.json({ error: "Failed to fetch usage" }, { status: 500 });
  }
}
