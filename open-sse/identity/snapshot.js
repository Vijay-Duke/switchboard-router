import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PROFILES } from "./catalog.js";
import { mapStainlessArch, mapStainlessOs } from "./os.js";

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const POLLED_PROFILES = ["claude-cli", "codex-cli", "gemini-cli"];
const memory = new Map();
const deviceProfiles = new Map();
let warnedStale = new Set();
let pollTimer = null;

function identityDir() {
  const dataDir = process.env.DATA_DIR || path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".switchboard",
  );
  return path.join(dataDir, "identity");
}

function snapshotPath(profileId) {
  return path.join(identityDir(), `${profileId}.json`);
}

function loadCommittedVersions() {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "open-sse", "identity", "snapshots", "versions.json"),
      "utf8",
    ));
  } catch {
    try {
      return JSON.parse(fs.readFileSync(new URL("./snapshots/versions.json", import.meta.url), "utf8"));
    } catch {
      return {};
    }
  }
}

const committedVersions = loadCommittedVersions();

function fallbackSnapshot(profileId) {
  const metadata = committedVersions[profileId];
  const version = metadata?.version;
  if (!version) return null;
  if (profileId !== "claude-cli") return { version, latestVersion: metadata.latestVersion };
  const tlsSpecRev = metadata.tlsSpecRev || version;
  return {
    version,
    billingVersion: version,
    tlsSpecRev,
    latestVersion: metadata.latestVersion,
    capturedAt: metadata.capturedAt,
    entrypoint: "cli",
    userAgent: `claude-cli/${version} (external, cli)`,
    packageVersion: metadata.packageVersion || "0.94.0",
    runtimeVersion: metadata.runtimeVersion || "v22.19.0",
    betas: metadata.betas || "claude-code-20250219,oauth-2025-04-20",
  };
}

function versionParts(version) {
  const parts = String(version || "").split(".").map(Number);
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : null;
}

function tlsCaptureVersion(snapshot) {
  const match = String(snapshot?.tlsSpecRev || "").match(/(\d+\.\d+\.\d+)/);
  return match?.[1] || null;
}

function committedClaudeCaptureVersion() {
  return extractVersion(committedVersions["claude-cli"]?.tlsSpecRev)
    || committedVersions["claude-cli"]?.version
    || null;
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function sameMajorMinor(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  return !!left && !!right && left[0] === right[0] && left[1] === right[1];
}

export function isCompleteClaudeSnapshot(snapshot) {
  return !!(
    snapshot?.version
    && snapshot?.billingVersion === snapshot.version
    && tlsCaptureVersion(snapshot) === snapshot.version
    && snapshot.version === committedClaudeCaptureVersion()
    && snapshot?.userAgent?.includes(`claude-cli/${snapshot.version}`)
    && snapshot?.packageVersion
    && snapshot?.runtimeVersion
    && snapshot?.betas
  );
}

export function claudeSnapshotVersions(snapshot) {
  return {
    version: snapshot?.version || null,
    billingVersion: snapshot?.billingVersion || null,
    tlsVersion: tlsCaptureVersion(snapshot),
    userAgentVersion: extractVersion(snapshot?.userAgent),
  };
}

export function getSnapshot(profileId) {
  if (memory.has(profileId)) return memory.get(profileId);
  let snapshot = null;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath(profileId), "utf8"));
  } catch {
    snapshot = fallbackSnapshot(profileId);
  }
  if (profileId === "claude-cli" && !isCompleteClaudeSnapshot(snapshot)) {
    snapshot = fallbackSnapshot(profileId);
  }
  if (snapshot) memory.set(profileId, snapshot);
  return snapshot;
}

export function getConsistentSnapshot(profileId) {
  const snapshot = getSnapshot(profileId);
  if (profileId !== "claude-cli") return snapshot;
  return isCompleteClaudeSnapshot(snapshot) ? snapshot : fallbackSnapshot(profileId);
}

export function setSnapshot(profileId, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  memory.set(profileId, snapshot);
  if (process.env.NODE_ENV === "test") return;
  try {
    fs.mkdirSync(identityDir(), { recursive: true });
    fs.writeFileSync(snapshotPath(profileId), JSON.stringify(snapshot, null, 2));
  } catch {
    // Persistence is best-effort; memory still holds the live snapshot.
  }
}

function extractVersion(userAgent) {
  if (typeof userAgent !== "string") return null;
  const match = userAgent.match(/claude-cli\/(\d+\.\d+\.\d+)/i)
    || userAgent.match(/codex_cli_rs\/(\d+\.\d+\.\d+)/i)
    || userAgent.match(/GeminiCLI\/(\d+\.\d+\.\d+)/i)
    || userAgent.match(/Cline\/(\d+\.\d+\.\d+)/i)
    || userAgent.match(/antigravity\/(\d+\.\d+\.\d+)/i)
    || userAgent.match(/QwenCode\/(\d+\.\d+\.\d+)/i)
    || userAgent.match(/GitHubCopilotChat\/(\d+\.\d+\.\d+)/i);
  return match ? match[1] : null;
}

function lowerMap(headers) {
  const out = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

export function harvest(profileId, headers) {
  const h = lowerMap(headers);
  const userAgent = h["user-agent"];
  const version = extractVersion(userAgent);
  if (!userAgent || !version) return false;
  if (profileId === "claude-cli") {
    const packageVersion = h["x-stainless-package-version"];
    const runtimeVersion = h["x-stainless-runtime-version"];
    const betas = h["anthropic-beta"];
    if (!packageVersion || !runtimeVersion || !betas) return false;
    const current = getConsistentSnapshot(profileId) || {};
    const capturedVersion = tlsCaptureVersion(current);
    if (capturedVersion && version !== capturedVersion) {
      markStale(profileId, `harvest ${version} does not match TLS capture ${current.tlsSpecRev}`);
      return false;
    }
    setSnapshot(profileId, {
      ...current,
      version,
      billingVersion: version,
      userAgent,
      packageVersion,
      runtimeVersion,
      betas,
      os: current.os || h["x-stainless-os"],
      arch: current.arch || h["x-stainless-arch"],
      entrypoint: /\(external,\s*([^)]+)\)/.exec(userAgent)?.[1] || "cli",
      harvestedAt: Date.now(),
    });
    return true;
  }
  if (profileId === "copilot") {
    const chatVersion = String(h["editor-plugin-version"] || "").match(/copilot-chat\/(\d+\.\d+\.\d+)/i)?.[1];
    const vscodeVersion = String(h["editor-version"] || "").match(/vscode\/(\d+\.\d+\.\d+)/i)?.[1];
    const apiVersion = h["x-github-api-version"];
    if (!chatVersion || chatVersion !== version || !vscodeVersion || !apiVersion) return false;
    setSnapshot(profileId, { ...getSnapshot(profileId), version, chatVersion, vscodeVersion, apiVersion, userAgent, harvestedAt: Date.now() });
    return true;
  }
  setSnapshot(profileId, {
    ...getSnapshot(profileId),
    version,
    userAgent,
    harvestedAt: Date.now(),
  });
  return true;
}

export function getDeviceProfile(credentialId) {
  const key = credentialId || "anonymous";
  if (deviceProfiles.has(key)) return deviceProfiles.get(key);
  const seed = createHash("sha256").update(`device:${key}`).digest("hex");
  const profile = {
    buildHash: seed.slice(0, 3),
    deviceId: seed,
    accountUuid: `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`,
    os: mapStainlessOs(),
    arch: mapStainlessArch(),
  };
  deviceProfiles.set(key, profile);
  return profile;
}

export function markStale(profileId, message) {
  if (warnedStale.has(profileId)) return;
  warnedStale.add(profileId);
  console.warn(`[IDENTITY_STALE] ${profileId}: ${message}`);
}

async function fetchLatestVersion(profileId, fetchImpl) {
  const packageName = PROFILES[profileId]?.source?.npm;
  if (!packageName) return null;
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const payload = await response.json();
  return versionParts(payload?.version) ? payload.version : null;
}

export async function pollIdentityVersions(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return;
  await Promise.all(POLLED_PROFILES.map(async (profileId) => {
    try {
      const latestVersion = await fetchLatestVersion(profileId, fetchImpl);
      if (!latestVersion) return;
      const current = getConsistentSnapshot(profileId) || fallbackSnapshot(profileId) || {};
      if (profileId === "claude-cli") {
        if (compareVersions(latestVersion, current.version) > 0) {
          setSnapshot(profileId, { ...current, latestVersion, checkedAt: Date.now() });
          markStale(profileId, `npm ${latestVersion} is ahead of captured tuple ${current.version}`);
        }
        return;
      }
      if (compareVersions(latestVersion, current.version) <= 0) return;
      const userAgent = profileId === "codex-cli" ? `codex_cli_rs/${latestVersion}` : current.userAgent;
      setSnapshot(profileId, { ...current, version: latestVersion, ...(userAgent ? { userAgent } : {}), checkedAt: Date.now() });
    } catch {
      // Registry polling is best-effort and never blocks requests.
    }
  }));
}

export function startIdentityPolling(fetchImpl = globalThis.fetch) {
  if (pollTimer || typeof fetchImpl !== "function") return pollTimer;
  void pollIdentityVersions(fetchImpl);
  pollTimer = setInterval(() => void pollIdentityVersions(fetchImpl), POLL_INTERVAL_MS);
  pollTimer.unref?.();
  return pollTimer;
}

export function stopIdentityPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

export function resetIdentityState() {
  stopIdentityPolling();
  memory.clear();
  deviceProfiles.clear();
  warnedStale = new Set();
}

export function knownProfileIds() {
  return Object.keys(PROFILES);
}

if (process.env.NODE_ENV !== "test" && process.env.SWITCHBOARD_DISABLE_IDENTITY_POLL !== "1") {
  queueMicrotask(() => startIdentityPolling());
}
