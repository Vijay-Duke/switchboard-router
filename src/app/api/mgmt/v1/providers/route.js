// @ts-check
import { getProviderConnections, getProviderNodes } from "@/lib/db/index.js";
import { redactSecrets } from "@/models";
import { fail, ok, requireManagementAuth } from "../_lib/http.js";

export const dynamic = "force-dynamic";

/** @param {Record<string, any>} connection */
function safeAccount(connection) {
  const safe = redactSecrets(connection);
  return {
    id: safe.id, provider: safe.provider, authType: safe.authType,
    name: safe.name, email: safe.email, priority: safe.priority,
    isActive: safe.isActive, createdAt: safe.createdAt, updatedAt: safe.updatedAt,
    displayName: safe.displayName, defaultModel: safe.defaultModel,
    globalPriority: safe.globalPriority, testStatus: safe.testStatus,
    lastTested: safe.lastTested, lastError: safe.lastError,
    lastErrorAt: safe.lastErrorAt, rateLimitedUntil: safe.rateLimitedUntil,
    errorCode: safe.errorCode,
    hasApiKey: Boolean(connection.apiKey),
    hasOAuth: Boolean(connection.accessToken || connection.refreshToken),
    hasIdToken: Boolean(connection.idToken),
  };
}

/** @param {Record<string, any>} node */
function safeNode(node) {
  return {
    id: node.id, name: node.name, type: node.type, prefix: node.prefix,
    apiType: node.apiType, baseUrl: node.baseUrl,
    createdAt: node.createdAt, updatedAt: node.updatedAt,
  };
}

/** @param {Record<string, any>[]} connections */
function groupProviders(connections) {
  const groups = new Map();
  for (const connection of connections) {
    const provider = connection.provider;
    const group = groups.get(provider) || { provider, accounts: [] };
    group.accounts.push(safeAccount(connection));
    groups.set(provider, group);
  }
  return [...groups.values()];
}

/** GET /api/mgmt/v1/providers */
export async function GET(request) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    const [connections, nodes] = await Promise.all([
      getProviderConnections(), getProviderNodes(),
    ]);
    const providers = groupProviders(connections);
    return ok({
      providers,
      nodes: nodes.map(safeNode),
      counts: { providers: providers.length, accounts: connections.length, nodes: nodes.length },
    });
  } catch {
    return fail(500, "Failed to fetch providers");
  }
}
