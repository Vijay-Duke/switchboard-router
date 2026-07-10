// @ts-check
/**
 * Machine-bound CLI / internal-probe token (`x-switchboard-cli-token`).
 * Same secret as dashboardGuard and server-side model pings.
 */
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { timingSafeEqualStr } from "@/lib/crypto/secrets.js";

export const CLI_TOKEN_HEADER = "x-switchboard-cli-token";
export const CLI_TOKEN_SALT = "switchboard-cli-auth";

/** @type {string|null} */
let cachedCliToken = null;

/** @returns {Promise<string>} */
export async function getCliToken() {
  if (!cachedCliToken) {
    cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  }
  return cachedCliToken;
}

/**
 * @param {Request | { headers?: { get?: (name: string) => string|null } }} request
 * @returns {Promise<boolean>}
 */
export async function hasValidCliToken(request) {
  const token = request?.headers?.get?.(CLI_TOKEN_HEADER);
  if (!token) return false;
  return timingSafeEqualStr(token, await getCliToken());
}

/** Test helper — clears in-memory cache. */
export function __resetCliTokenCacheForTests() {
  cachedCliToken = null;
}
