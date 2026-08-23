import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import { mapStainlessArch, mapStainlessOs, hostArch, hostPlatform } from "./os.js";
import { GROK_CLI_CLIENT_IDENTIFIER, GROK_CLI_VERSION } from "../config/grokCli.js";

const CLAUDE_BETAS = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28";

const CLAUDE_MESSAGES_HEADER_ORDER = [
  "Accept",
  "Authorization",
  "Content-Type",
  "User-Agent",
  "X-Claude-Code-Session-Id",
  "X-Stainless-Arch",
  "X-Stainless-Lang",
  "X-Stainless-OS",
  "X-Stainless-Package-Version",
  "X-Stainless-Retry-Count",
  "X-Stainless-Runtime",
  "X-Stainless-Runtime-Version",
  "X-Stainless-Timeout",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-version",
  "x-app",
  "x-client-request-id",
  "Connection",
  "Host",
  "Accept-Encoding",
  "Content-Length",
];

const CLAUDE_COUNT_TOKENS_HEADER_ORDER = CLAUDE_MESSAGES_HEADER_ORDER.filter(
  (name) => name !== "X-Stainless-Timeout",
);

function claudeHeaders(snapshot) {
  const version = snapshot?.version || "2.1.220";
  const entrypoint = snapshot?.entrypoint || "cli";
  return {
    "Anthropic-Version": ANTHROPIC_API_VERSION,
    "Anthropic-Beta": snapshot?.betas || CLAUDE_BETAS,
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    "User-Agent": snapshot?.userAgent || `claude-cli/${version} (external, ${entrypoint})`,
    "X-App": "cli",
    "X-Stainless-Runtime-Version": snapshot?.runtimeVersion || process.version,
    "X-Stainless-Package-Version": snapshot?.packageVersion || "0.94.0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Lang": "js",
    "X-Stainless-Arch": snapshot?.arch || mapStainlessArch(),
    "X-Stainless-Os": snapshot?.os || mapStainlessOs(),
    "X-Stainless-Timeout": "600",
  };
}

function openaiNodeHeaders() {
  return {
    "User-Agent": `OpenAI/NodeJS/${process.version.replace(/^v/, "")}`,
  };
}

function clineHeaders(snapshot) {
  const version = snapshot?.version || "3.0.0";
  return {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "User-Agent": `Cline/${version}`,
    "X-PLATFORM": hostPlatform() || "unknown",
    "X-PLATFORM-VERSION": process.version || "unknown",
    "X-CLIENT-TYPE": "extension",
    "X-CLIENT-VERSION": version,
    "X-CORE-VERSION": version,
    "X-IS-MULTIROOT": "false",
  };
}

function geminiHeaders(snapshot) {
  const version = snapshot?.version || "0.56.0";
  const model = snapshot?.upstreamModel || "unknown";
  const a = hostArch() === "ia32" ? "x86" : hostArch();
  return {
    "User-Agent": `GeminiCLI/${version}/${model} (${hostPlatform()}; ${a}; terminal)`,
    "X-Goog-Api-Client": snapshot?.apiClient || "google-genai-sdk/1.41.0 gl-node/v22.19.0",
  };
}

function antigravityHeaders(snapshot) {
  const version = snapshot?.version || "1.107.0";
  return {
    "User-Agent": `antigravity/${version} ${hostPlatform()}/${hostArch()}`,
  };
}

function copilotHeaders(snapshot) {
  const vscode = snapshot?.vscodeVersion || "1.110.0";
  const chat = snapshot?.chatVersion || snapshot?.version || "0.38.0";
  return {
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${vscode}`,
    "editor-plugin-version": `copilot-chat/${chat}`,
    "user-agent": `GitHubCopilotChat/${chat}`,
    "openai-intent": "conversation-panel",
    "x-github-api-version": snapshot?.apiVersion || "2025-04-01",
    "x-vscode-user-agent-library-version": "electron-fetch",
    "X-Initiator": "user",
  };
}

function qwenHeaders(snapshot) {
  const { os, arch, stainlessOs, stainlessArch } = snapshot?.qwenOsArch || {
    os: hostPlatform() === "win32" ? "windows" : hostPlatform() === "darwin" ? "darwin" : "linux",
    arch: hostArch() === "arm64" ? "arm64" : "x64",
    stainlessOs: mapStainlessOs(),
    stainlessArch: mapStainlessArch(),
  };
  const version = snapshot?.version || "0.12.3";
  const ua = `QwenCode/${version} (${os}; ${arch})`;
  return {
    "User-Agent": ua,
    "X-DashScope-UserAgent": ua,
    "X-Stainless-Arch": stainlessArch,
    "X-Stainless-Os": stainlessOs,
    "X-Stainless-Lang": "js",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": snapshot?.runtimeVersion || process.version,
    "X-Stainless-Package-Version": snapshot?.packageVersion || "5.11.0",
  };
}

function kimiHeaders() {
  return {
    "X-Msh-Version": "2.1.2",
    "X-Msh-Device-Model": `${hostPlatform()} ${hostArch()}`,
  };
}

function grokCliHeaders(snapshot) {
  return {
    "User-Agent": `grok-cli/${snapshot?.version || "1.0.0"}`,
  };
}

function grokBuildHeaders() {
  return {
    "User-Agent": `grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`,
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_VERSION,
  };
}

function chromeHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}

function codexHeaders(snapshot) {
  const version = snapshot?.version || "0.149.0";
  return {
    originator: "codex_cli_rs",
    "User-Agent": `codex_cli_rs/${version}`,
    version,
  };
}

/** @type {Record<string, object>} */
export const PROFILES = {
  "claude-cli": {
    id: "claude-cli",
    tls: "claude-code",
    alpn: ["http/1.1"],
    headerOrder: CLAUDE_MESSAGES_HEADER_ORDER,
    source: { npm: "@anthropic-ai/claude-code", capture: "claude-code-native", tlsSpec: "claude-code" },
    headers: claudeHeaders,
  },
  "codex-cli": {
    id: "codex-cli",
    tls: "chrome",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["Authorization", "Content-Type", "originator", "session_id", "User-Agent", "version", "chatgpt-account-id"],
    source: { npm: "@openai/codex" },
    headers: codexHeaders,
  },
  "gemini-cli": {
    id: "gemini-cli",
    tls: "node",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["Content-Type", "Authorization", "User-Agent", "X-Goog-Api-Client", "Accept"],
    source: { npm: "@google/gemini-cli" },
    headers: geminiHeaders,
  },
  "openai-node": {
    id: "openai-node",
    tls: "node",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["Authorization", "Content-Type", "User-Agent"],
    source: { npm: "openai" },
    headers: openaiNodeHeaders,
  },
  cline: {
    id: "cline",
    tls: "node",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["Authorization", "Content-Type", "HTTP-Referer", "X-Title", "User-Agent", "X-PLATFORM", "X-PLATFORM-VERSION", "X-CLIENT-TYPE", "X-CLIENT-VERSION", "X-CORE-VERSION", "X-IS-MULTIROOT"],
    source: { npm: "cline" },
    headers: clineHeaders,
  },
  chrome: {
    id: "chrome",
    tls: "chrome",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["User-Agent", "Accept", "Accept-Language", "Accept-Encoding"],
    source: { capture: "chrome" },
    headers: chromeHeaders,
  },
  cursor: {
    id: "cursor",
    tls: "node",
    alpn: ["h2", "http/1.1"],
    headerOrder: [],
    source: { capture: "cursor" },
    headers: () => ({}),
  },
  antigravity: {
    id: "antigravity",
    tls: "node",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["Authorization", "Content-Type", "User-Agent", "Accept"],
    source: { capture: "antigravity" },
    headers: antigravityHeaders,
  },
  copilot: {
    id: "copilot",
    tls: "node",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["Authorization", "Content-Type", "copilot-integration-id", "editor-version", "editor-plugin-version", "user-agent", "openai-intent", "x-github-api-version"],
    source: { capture: "github-copilot" },
    headers: copilotHeaders,
  },
  qwen: {
    id: "qwen",
    tls: "node",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["Authorization", "Content-Type", "User-Agent", "X-Stainless-Arch", "X-Stainless-Os"],
    source: { capture: "qwen-code" },
    headers: qwenHeaders,
  },
  kimi: {
    id: "kimi",
    tls: "node",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["Authorization", "Content-Type", "X-Msh-Version", "X-Msh-Device-Model"],
    source: { capture: "kimi-code" },
    headers: kimiHeaders,
  },
  "grok-cli": {
    id: "grok-cli",
    tls: "node",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["Authorization", "Content-Type", "User-Agent"],
    source: { capture: "grok-cli" },
    headers: grokCliHeaders,
  },
  "grok-build": {
    id: "grok-build",
    tls: "node",
    alpn: ["h2", "http/1.1"],
    headerOrder: ["Authorization", "Content-Type", "Accept", "User-Agent", "x-grok-client-identifier", "x-grok-client-version"],
    source: { capture: "@xai-official/grok 0.2.99" },
    headers: grokBuildHeaders,
  },
};

export function getProfile(profileId) {
  return PROFILES[profileId] || PROFILES["openai-node"];
}

export function profileHeaders(profileId, snapshot) {
  const profile = getProfile(profileId);
  return typeof profile.headers === "function" ? profile.headers(snapshot) : { ...(profile.headers || {}) };
}

const OPENAI_FAMILY = new Set(["openai", "openai-responses", "openai-compat"]);
const CLAUDE_FAMILY = new Set(["claude"]);

/**
 * @param {string|object|null} identity
 * @param {{ format?: string, provider?: string }} [hint]
 */
export function resolveProfileId(identity, hint = {}) {
  if (typeof identity === "string" && identity) return identity;
  if (identity && typeof identity === "object" && identity.profile) return identity.profile;
  const format = hint.format || "";
  const provider = hint.provider || "";
  if (format === "claude" || CLAUDE_FAMILY.has(format) || provider === "claude" || provider.startsWith("anthropic-compatible")) {
    return "claude-cli";
  }
  if (provider === "codex") return "codex-cli";
  if (provider === "gemini-cli") return "gemini-cli";
  if (provider === "antigravity") return "antigravity";
  if (provider === "github") return "copilot";
  if (provider === "qwen") return "qwen";
  if (provider === "cline" || provider === "clinepass") return "cline";
  if (provider === "kimi" || provider === "kimi-coding") return "kimi";
  if (provider === "xai") return "grok-cli";
  if (provider === "grok-cli") return "grok-build";
  if (provider === "grok-web") return "chrome";
  if (provider === "cursor" || format === "cursor") return "cursor";
  if (OPENAI_FAMILY.has(format) || format === "openai" || !format) return "openai-node";
  return "openai-node";
}

const CLAUDE_TUPLE_HEADERS = new Set([
  "user-agent",
  "anthropic-beta",
  "x-stainless-package-version",
  "x-stainless-runtime-version",
  "x-stainless-os",
  "x-stainless-arch",
]);

const CLAUDE_ENFORCED_HEADERS = new Set([
  "x-stainless-helper-method",
  "x-stainless-retry-count",
]);

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function claudeOverlayTupleMatches(overlay, snapshot) {
  const values = Object.fromEntries([...CLAUDE_TUPLE_HEADERS].map((name) => [name, headerValue(overlay, name)]));
  const present = Object.values(values).filter((value) => value != null).length;
  if (present === 0) return false;
  if (present !== CLAUDE_TUPLE_HEADERS.size) return false;
  const version = String(values["user-agent"]).match(/claude-(?:cli|code)\/(\d+\.\d+\.\d+)/i)?.[1];
  return version === snapshot?.version;
}

function sanitizeClaudeOverlay(overlay, snapshot) {
  const sanitized = { ...(overlay || {}) };
  const keepTuple = claudeOverlayTupleMatches(sanitized, snapshot);
  for (const key of Object.keys(sanitized)) {
    const lower = key.toLowerCase();
    if (CLAUDE_ENFORCED_HEADERS.has(lower) || (!keepTuple && CLAUDE_TUPLE_HEADERS.has(lower))) delete sanitized[key];
  }
  return sanitized;
}

export function applyIdentity(base, profileId, opts = {}) {
  const profile = getProfile(profileId);
  const identity = profileHeaders(profileId, opts.snapshot);
  if (opts.stream === true && profileId === "claude-cli") {
    identity["X-Stainless-Helper-Method"] = "stream";
  } else if (profileId === "claude-cli") {
    delete identity["X-Stainless-Helper-Method"];
  }
  if (typeof opts.retryCount === "number" && profileId === "claude-cli") {
    identity["X-Stainless-Retry-Count"] = String(opts.retryCount);
  }
  const auth = new Map();
  for (const [key, value] of Object.entries(base || {})) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "api-key" || lower === "cookie") {
      auth.set(lower, [key, value]);
    }
  }
  const merged = mergeHeadersCaseInsensitive(base, identity);
  const overlay = opts.overlay && typeof opts.overlay === "object"
    ? (profileId === "claude-cli" ? sanitizeClaudeOverlay(opts.overlay, opts.snapshot) : { ...opts.overlay })
    : {};
  for (const key of Object.keys(overlay)) {
    if (auth.has(key.toLowerCase())) delete overlay[key];
  }
  const overlaid = mergeHeadersCaseInsensitive(merged, overlay);
  if (profileId === "claude-cli") {
    if (opts.stream === true) overlaid["X-Stainless-Helper-Method"] = "stream";
    else {
      for (const key of Object.keys(overlaid)) if (key.toLowerCase() === "x-stainless-helper-method") delete overlaid[key];
    }
    if (typeof opts.retryCount === "number") {
      for (const key of Object.keys(overlaid)) if (key.toLowerCase() === "x-stainless-retry-count") delete overlaid[key];
      overlaid["X-Stainless-Retry-Count"] = String(opts.retryCount);
    }
  }
  for (const [lower, [key, value]] of auth) {
    for (const existing of Object.keys(overlaid)) {
      if (existing.toLowerCase() === lower) delete overlaid[existing];
    }
    overlaid[key] = value;
  }
  if (profile?.headerOrder) return orderHeaders(overlaid, profile.headerOrder);
  return overlaid;
}

function mergeHeadersCaseInsensitive(...sources) {
  const out = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      const existing = Object.keys(out).find((name) => name.toLowerCase() === key.toLowerCase());
      if (existing) delete out[existing];
      out[key] = value;
    }
  }
  return out;
}

export function orderHeaders(headers, order) {
  if (!order || !order.length) return { ...headers };
  const used = new Set();
  const out = {};
  const lookup = new Map();
  for (const [k, v] of Object.entries(headers)) lookup.set(k.toLowerCase(), [k, v]);
  for (const name of order) {
    const hit = lookup.get(name.toLowerCase());
    if (!hit) continue;
    out[hit[0]] = hit[1];
    used.add(name.toLowerCase());
  }
  for (const [k, v] of Object.entries(headers)) {
    if (!used.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export { CLAUDE_BETAS, CLAUDE_MESSAGES_HEADER_ORDER, CLAUDE_COUNT_TOKENS_HEADER_ORDER };
