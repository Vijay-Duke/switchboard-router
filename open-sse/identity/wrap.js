import { stripLeaks } from "./leaks.js";
import { applyIdentity, resolveProfileId, getProfile, orderHeaders, CLAUDE_COUNT_TOKENS_HEADER_ORDER } from "./catalog.js";
import { claudeSnapshotVersions, getConsistentSnapshot, getDeviceProfile } from "./snapshot.js";

const AUTH_FALLBACK_UA = {
  "claude-cli": "claude-cli/2.1.220 (external, cli)",
  "codex-cli": "codex_cli_rs/0.149.0",
  "gemini-cli": "GeminiCLI/0.56.0/unknown (linux; x64; terminal)",
  cline: "Cline/3.0.0",
  "openai-node": "OpenAI/NodeJS/22",
  chrome: "Mozilla/5.0",
  antigravity: "antigravity/1.107.0 linux/x64",
  copilot: "GitHubCopilotChat/0.38.0",
  qwen: "QwenCode/0.12.3 (linux; x64)",
  "grok-cli": "grok-cli/1.0.0",
};

function findUserAgentKey(headers) {
  return Object.keys(headers).find((k) => k.toLowerCase() === "user-agent");
}

function validateClaudeIdentity(headers, snapshot) {
  const versions = claudeSnapshotVersions(snapshot);
  const userAgentKey = findUserAgentKey(headers);
  const wireUaVersion = String(userAgentKey ? headers[userAgentKey] : "").match(/claude-(?:cli|code)\/(\d+\.\d+\.\d+)/i)?.[1] || null;
  if (
    !versions.version
    || versions.billingVersion !== versions.version
    || versions.tlsVersion !== versions.version
    || versions.userAgentVersion !== versions.version
    || wireUaVersion !== versions.version
  ) {
    throw new Error(`Claude identity mismatch: ua=${wireUaVersion || versions.userAgentVersion} version=${versions.version} billing=${versions.billingVersion} tls=${versions.tlsVersion}`);
  }
}

/**
 * Strip leaks, merge catalog identity, restore UA if empty.
 * @param {Headers|Record<string, string>} headers
 * @param {{ identity?: string|object, provider?: string, format?: string, snapshot?: object, overlay?: object, credentialId?: string, stream?: boolean, retryCount?: number }} opts
 */
export function wrapHeaders(headers, opts = {}) {
  const stripped = stripLeaks(headers);
  const profileId = resolveProfileId(opts.identity, { format: opts.format, provider: opts.provider });
  const snapshot = opts.snapshot || getConsistentSnapshot(profileId);
  const device = profileId === "claude-cli" ? getDeviceProfile(opts.credentialId) : null;
  const merged = applyIdentity(stripped, profileId, {
    snapshot: device ? { ...snapshot, os: device.os, arch: device.arch } : snapshot,
    overlay: opts.overlay,
    stream: opts.stream,
    retryCount: opts.retryCount,
  });
  const profile = getProfile(profileId);
  let cleaned = stripLeaks(merged);
  if (profileId === "claude-cli" && opts.requestPath?.startsWith("/v1/messages/count_tokens")) {
    for (const key of Object.keys(cleaned)) {
      if (key.toLowerCase() === "x-stainless-timeout") delete cleaned[key];
    }
    cleaned = orderHeaders(cleaned, CLAUDE_COUNT_TOKENS_HEADER_ORDER);
  }
  if (!findUserAgentKey(cleaned) && profileId !== "cursor") {
    const ua = snapshot?.userAgent || AUTH_FALLBACK_UA[profileId] || AUTH_FALLBACK_UA["openai-node"];
    cleaned["User-Agent"] = ua;
  }
  if (profileId === "claude-cli") validateClaudeIdentity(cleaned, snapshot);
  return {
    headers: stripLeaks(cleaned),
    profileId,
    tls: profile?.tls || "node",
    alpn: profile?.alpn || ["h2", "http/1.1"],
    tlsSpecRev: snapshot?.tlsSpecRev,
  };
}

export { resolveProfileId, getProfile };
