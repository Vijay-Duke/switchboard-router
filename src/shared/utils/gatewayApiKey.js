// @ts-check
import {
  isClaudePassThroughRequest,
  SWITCHBOARD_KEY_HEADER,
} from "@/shared/claudeGateway.js";

/**
 * Extract the credential used to authorize access to Switchboard. The
 * dedicated header wins because a native client may need Authorization for
 * its upstream OAuth session at the same time.
 *
 * @param {{ get: (name: string) => string|null }} headers
 */
export function extractGatewayApiKey(headers) {
  const switchboardKey = headers.get(SWITCHBOARD_KEY_HEADER);
  if (switchboardKey) return switchboardKey;

  // In Claude pass-through mode Authorization belongs exclusively to the
  // upstream Anthropic session. It must never become Switchboard's API key,
  // even when the dedicated gateway header is missing.
  if (isClaudePassThroughRequest(headers)) {
    return null;
  }

  const authHeader = headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  return headers.get("x-api-key") || headers.get("x-goog-api-key") || null;
}
