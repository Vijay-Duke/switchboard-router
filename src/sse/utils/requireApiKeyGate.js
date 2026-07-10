// @ts-check
import { isLocalRequest } from "@/dashboardGuard";

/**
 * L3: shared requireApiKey check for SSE public endpoints.
 * Valid machine CLI token (dashboard probes / CLI) bypasses the dashboard API-key gate.
 *
 * @param {{ requireApiKey?: boolean }} settings
 * @param {string|null|undefined} apiKey
 * @param {{
 *   isValidApiKey: (k: string) => Promise<boolean>|boolean,
 *   log?: { warn?: Function },
 *   errorResponse: Function,
 *   HTTP_STATUS: { UNAUTHORIZED: number },
 *   request?: Request | { headers?: { get?: (name: string) => string|null } },
 *   hasValidCliToken?: (req: any) => Promise<boolean>|boolean,
 * }} deps
 * @returns {Promise<Response|null>} error response or null if ok
 */
export async function gateRequireApiKey(settings, apiKey, deps) {
  if (!settings?.requireApiKey) return null;

  const { isValidApiKey, log, errorResponse, HTTP_STATUS, request, hasValidCliToken } = deps;

  // Keep this handler-level gate aligned with dashboardGuard: verified loopback
  // clients are local single-user traffic and do not need a persisted gateway
  // key. isLocalRequest fails closed unless locality is proven by the loopback
  // bind or by socket-derived headers from custom-server.js.
  if (request && isLocalRequest(request)) return null;

  // Internal model probes and CLI use x-switchboard-cli-token; they must not require a
  // user-created Switchboard API key (OAuth-only setups have empty apiKeys).
  if (request && typeof hasValidCliToken === "function") {
    try {
      if (await hasValidCliToken(request)) return null;
    } catch {
      // Fall through to API-key check
    }
  }

  if (!apiKey) {
    log?.warn?.("AUTH", "Missing API key (requireApiKey=true)");
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
  }
  const ok = await isValidApiKey(apiKey);
  if (!ok) {
    log?.warn?.("AUTH", "Invalid API key (requireApiKey=true)");
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }
  return null;
}
