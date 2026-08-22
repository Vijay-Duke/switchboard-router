import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FILE = path.join(ROOT, "open-sse", "identity", "snapshots", "versions.json");
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldRefresh(metadata, now = Date.now()) {
  return now - Date.parse(metadata.releasedAt) > GRACE_MS;
}

export async function latestVersion(npm, fetchImpl = fetch) {
  const response = await fetchImpl(`https://registry.npmjs.org/${npm}/latest`);
  if (!response.ok) throw new Error(`npm lookup failed for ${npm}: ${response.status}`);
  const { version } = await response.json();
  if (!version) throw new Error(`npm lookup returned no version for ${npm}`);
  return version;
}

export async function refreshIdentityVersions({ file = DEFAULT_FILE, write = false, now = Date.now(), fetchImpl } = {}) {
  const snapshots = JSON.parse(await fs.readFile(file, "utf8"));
  const stale = [];
  for (const [profile, metadata] of Object.entries(snapshots)) {
    const version = await latestVersion(metadata.npm, fetchImpl);
    if (profile === "claude-cli") {
      if (version !== metadata.version && now - Date.parse(metadata.capturedAt) > GRACE_MS) {
        stale.push(`${profile}: captured ${metadata.version} → ${version}`);
      }
      if (write && version !== metadata.latestVersion) snapshots[profile] = { ...metadata, latestVersion: version };
      continue;
    }
    if (version === metadata.version) continue;
    if (shouldRefresh(metadata, now)) stale.push(`${profile}: ${metadata.version} → ${version}`);
    if (write) snapshots[profile] = { ...metadata, version, releasedAt: new Date(now).toISOString() };
  }
  if (write) await fs.writeFile(file, `${JSON.stringify(snapshots, null, 2)}\n`);
  if (stale.length && !write) throw new Error(`Identity fallback versions exceed 7-day grace:\n${stale.join("\n")}`);
  return snapshots;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  refreshIdentityVersions({ write }).then(() => {
    console.log(write ? "Identity fallback versions refreshed." : "Identity fallback versions are current.");
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
