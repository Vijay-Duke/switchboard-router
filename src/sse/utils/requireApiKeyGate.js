/**
 * L3: shared requireApiKey check for SSE public endpoints.
 * @param {{ requireApiKey?: boolean }} settings
 * @param {string|null|undefined} apiKey
 * @param {{ isValidApiKey: (k: string) => Promise<boolean>|boolean, log?: { warn?: Function }, errorResponse: Function, HTTP_STATUS: { UNAUTHORIZED: number } }} deps
 * @returns {Promise<Response|null>} error response or null if ok
 */
export async function gateRequireApiKey(settings, apiKey, deps) {
  if (!settings?.requireApiKey) return null;
  const { isValidApiKey, log, errorResponse, HTTP_STATUS } = deps;
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
