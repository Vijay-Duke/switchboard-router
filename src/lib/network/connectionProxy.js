// @ts-check
/**
 * Resolve optional per-connection outbound proxy.
 * Proxy pools feature has been removed — only legacy connectionProxy* fields apply.
 */

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * @param {Record<string, any>} [providerSpecificData]
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration for a connection.
 * @param {Record<string, any>} [providerSpecificData]
 */
export async function resolveConnectionProxyConfig(providerSpecificData = {}) {
  try {
    const legacy = normalizeLegacyProxy(providerSpecificData);

    if (legacy.connectionProxyEnabled && legacy.connectionProxyUrl) {
      return {
        source: "legacy",
        proxyPoolId: null,
        proxyPool: null,
        ...legacy,
        strictProxy: false,
        vercelRelayUrl: "",
      };
    }

    return {
      source: "none",
      proxyPoolId: null,
      proxyPool: null,
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: legacy.connectionNoProxy || "",
      strictProxy: false,
      vercelRelayUrl: "",
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );
    return {
      source: "error",
      proxyPoolId: null,
      proxyPool: null,
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      strictProxy: false,
      vercelRelayUrl: "",
    };
  }
}
