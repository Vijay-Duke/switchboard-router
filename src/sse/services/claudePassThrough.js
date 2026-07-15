// @ts-check
import {
  isClaudePassThroughRequest,
} from "@/shared/claudeGateway.js";

/**
 * Build request-scoped credentials from Claude Code's native subscription
 * token. These credentials are never persisted or refreshed by Switchboard.
 *
 * @param {{ request?: Request|null, provider: string, allowNativeOAuth?: boolean }} options
 * @returns {null|{
 *   id: string,
 *   connectionId: string,
 *   connectionName: string,
 *   accessToken: string,
 *   ephemeral: true,
 *   providerSpecificData: Record<string, never>,
 * }}
 */
export function getNativeClaudeCredentials({ request, provider, allowNativeOAuth = false }) {
  if (!allowNativeOAuth || provider !== "anthropic" || !request?.headers) return null;
  if (!isClaudePassThroughRequest(request.headers)) return null;

  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const accessToken = authorization.slice(7).trim();
  if (!accessToken) return null;

  return {
    id: "claude-native-oauth",
    connectionId: "claude-native-oauth",
    connectionName: "Claude Code subscription",
    accessToken,
    ephemeral: true,
    providerSpecificData: {},
  };
}
