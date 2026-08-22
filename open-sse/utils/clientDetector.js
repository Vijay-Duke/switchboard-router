/**
 * Detect CLI tool identity from request headers/body.
 * Used to determine if a request can be passed through losslessly.
 */

import { getConsistentSnapshot, harvest } from "../identity/snapshot.js";

// Map of CLI tool identifiers to provider IDs they are "native" to
const NATIVE_PAIRS = {
  "claude": ["claude", "anthropic"],
  "gemini-cli": ["gemini-cli"],
  "antigravity": ["antigravity"],
  "codex": ["codex"],
};

/**
 * Detect which CLI tool is making the request.
 * Returns one of: "claude" | "gemini-cli" | "antigravity" | "codex" | null
 * @param {object} headers - Lowercase header key/value object
 * @param {object} body    - Parsed request body
 */
export function detectClientTool(headers = {}, body = {}) {
  const ua = headers["user-agent"] || "";

  // Antigravity: detected via body field (not header)
  if (body.userAgent === "antigravity") return "antigravity";

  // GitHub Copilot requires both the official UA and editor identity headers.
  if (/^GitHubCopilotChat\/\d+\.\d+\.\d+/i.test(ua) && headers["editor-version"] && headers["editor-plugin-version"]) {
    return "github-copilot";
  }

  // Claude Code / Claude CLI. x-app alone is not a strong signature.
  if (/claude-(?:cli|code)\/\d+\.\d+\.\d+/i.test(ua)) return "claude";

  if (/^GeminiCLI\/\d+\.\d+\.\d+/i.test(ua)) return "gemini-cli";
  if (/^(?:codex_cli_rs|codex-cli)\/\d+\.\d+\.\d+/i.test(ua)) return "codex";
  if (/^Cline\/\d+\.\d+\.\d+/i.test(ua) && headers["x-client-type"] === "extension") return "cline";
  if (/^QwenCode\/\d+\.\d+\.\d+/i.test(ua)) return "qwen";

  // DeepSeek TUI
  if (ua.includes("deepseek-tui")) return "deepseek-tui";

  return null;
}

const PROFILE_BY_CLIENT = {
  claude: "claude-cli",
  codex: "codex-cli",
  "gemini-cli": "gemini-cli",
  antigravity: "antigravity",
  cline: "cline",
  qwen: "qwen",
  "github-copilot": "copilot",
};

const CLAUDE_USER_AGENT_RE = /^claude-(?:cli|code)\/(\d+\.\d+\.\d+)(?:\s|\(|$)/i;
const CLAUDE_CODE_SESSION_RE = /_session_([a-f0-9-]+)$/;

function nonEmptyHeader(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return typeof value === "string" && value.trim() ? value : null;
}

function confirmedClaudeSessionId(body) {
  const userId = body?.metadata?.user_id;
  if (typeof userId !== "string" || !userId) return null;
  const suffix = userId.match(CLAUDE_CODE_SESSION_RE)?.[1];
  if (suffix) return suffix;
  if (userId[0] !== "{") return null;
  try {
    const sessionId = JSON.parse(userId)?.session_id;
    if (typeof sessionId !== "string") return null;
    const normalized = sessionId.trim();
    return normalized && normalized.length <= 256 ? normalized : null;
  } catch {
    return null;
  }
}

export function isConfirmedClaudeClient(headers = {}, body = {}) {
  if (!headers || typeof headers !== "object") return false;
  const userAgent = nonEmptyHeader(headers, "user-agent");
  const version = userAgent?.match(CLAUDE_USER_AGENT_RE)?.[1];
  const capturedVersion = getConsistentSnapshot("claude-cli")?.version;
  return !!(
    version
    && version === capturedVersion
    && nonEmptyHeader(headers, "x-app")?.toLowerCase() === "cli"
    && nonEmptyHeader(headers, "anthropic-beta")
    && nonEmptyHeader(headers, "x-stainless-package-version")
    && nonEmptyHeader(headers, "x-stainless-runtime-version")
    && nonEmptyHeader(headers, "x-stainless-os")
    && nonEmptyHeader(headers, "x-stainless-arch")
    && confirmedClaudeSessionId(body)
  );
}

export function harvestDetectedClient(clientTool, headers = {}, body = {}) {
  const profileId = PROFILE_BY_CLIENT[clientTool];
  if (!profileId || detectClientTool(headers, body) !== clientTool) return false;
  if (clientTool !== "claude") return harvest(profileId, headers);
  if (!isConfirmedClaudeClient(headers, body)) return false;
  const userAgent = headers["user-agent"] || headers["User-Agent"];
  return harvest(profileId, {
    ...headers,
    "user-agent": userAgent.replace(/^claude-code\//i, "claude-cli/"),
  });
}

/**
 * Check if this CLI tool + provider pair should be passed through losslessly.
 * @param {string|null} clientTool - Result of detectClientTool()
 * @param {string} provider        - Provider ID (e.g. "claude", "gemini-cli")
 */
export function isNativePassthrough(clientTool, provider) {
  if (!clientTool) return false;
  const nativeProviders = NATIVE_PAIRS[clientTool];
  if (!nativeProviders) return false;
  // Support anthropic-compatible-* variants
  const normalizedProvider = provider.startsWith("anthropic-compatible")
    ? "anthropic"
    : provider;
  return nativeProviders.includes(normalizedProvider);
}
