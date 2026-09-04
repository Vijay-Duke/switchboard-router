import { stripLeaks } from "./leaks.js";
import { applyIdentity, resolveProfileId, getProfile, orderHeaders, CLAUDE_COUNT_TOKENS_HEADER_ORDER } from "./catalog.js";
import { claudeSnapshotVersions, getConsistentSnapshot, getDeviceProfile } from "./snapshot.js";
import { hostArch, hostPlatform } from "./os.js";

function nodeVersion() {
  return typeof process !== "undefined" && process.version ? process.version.replace(/^v/, "") : "unknown";
}

// Last-resort UAs when no snapshot exists. Versions prefer the live snapshot;
// platform/arch always reflect this host, never a frozen Mac/ARM default.
function fallbackUserAgent(profileId, snapshot) {
  const version = snapshot?.version;
  const plat = hostPlatform() || "linux";
  const arch = hostArch() === "ia32" ? "x86" : hostArch() || "x64";
  switch (profileId) {
    case "claude-cli": return `claude-cli/${version || "2.1.258"} (external, cli)`;
    case "codex-cli": return `codex_cli_rs/${version || "0.149.0"}`;
    case "gemini-cli": return `GeminiCLI/${version || "0.56.0"}/unknown (${plat}; ${arch}; terminal)`;
    case "cline": return `Cline/${version || "3.0.0"}`;
    case "antigravity": return `antigravity/${version || "1.107.0"} ${plat}/${arch}`;
    case "copilot": return `GitHubCopilotChat/${version || "0.38.0"}`;
    case "qwen": return `QwenCode/${version || "0.12.3"} (${plat}; ${arch})`;
    case "grok-cli": return `grok-cli/${version || "1.0.0"}`;
    case "grok-build": return `grok-shell/${version || "0.2.99"} (${plat}; ${arch})`;
    case "chrome": return "Mozilla/5.0";
    default: return `OpenAI/NodeJS/${nodeVersion()}`;
  }
}

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
    // No explicit identity → the profile was defaulted (openai-node etc.), so
    // a UA the caller set deliberately (Chrome for edge/google TTS) wins.
    preserveUserAgent: !opts.identity,
  });
  const profile = getProfile(profileId);
  let cleaned = stripLeaks(merged);
  if (profileId === "claude-cli" && opts.requestPath?.startsWith("/v1/messages/count_tokens")) {
    for (const key of Object.keys(cleaned)) {
      if (key.toLowerCase() === "x-stainless-timeout") delete cleaned[key];
    }
    cleaned = orderHeaders(cleaned, CLAUDE_COUNT_TOKENS_HEADER_ORDER);
  }
  if (!findUserAgentKey(cleaned)) {
    // Every hop egresses with an official-client UA — including cursor, which
    // previously went out fingerprint-less. A caller-set UA is preserved by
    // applyIdentity above, so this only fills a genuinely missing one.
    const ua = snapshot?.userAgent || fallbackUserAgent(profileId, snapshot);
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
