// @ts-check
import https from "https";
import pkg from "../../../../package.json" with { type: "json" };

/**
 * Resolve which npm package to poll for updates.
 * Prefer env override. Default: switchboard-router (free npm name for this product).
 * Do NOT default to bare "switchboard" — taken by an unrelated event library (v1.3.0).
 * Keep in sync with UPDATER_CONFIG.npmPackageName in shared/constants/config.js.
 */
function resolveNpmPackageName() {
  const fromEnv = process.env.SWITCHBOARD_NPM_PACKAGE || process.env.NPM_UPDATE_PACKAGE;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return "switchboard-router";
}

/**
 * Fetch latest version metadata from the npm registry.
 * @param {string} packageName
 * @returns {Promise<{ version: string|null, name?: string, description?: string }|null>}
 */
function fetchLatestPackage(packageName) {
  return new Promise((resolve) => {
    if (!packageName) {
      resolve(null);
      return;
    }
    const req = https.get(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      { timeout: 4000 },
      (res) => {
        // 404 / errors → no update, not a false positive
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          resolve(null);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve({
              version: typeof json.version === "string" ? json.version : null,
              name: typeof json.name === "string" ? json.name : packageName,
              description: typeof json.description === "string" ? json.description : "",
            });
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Semver-ish compare (major.minor.patch). Returns 1 if a>b, -1 if a<b, 0 if equal.
 * Non-numeric / missing segments treated as 0.
 */
export function compareVersions(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * Reject registry hits that are clearly not our product (name collision protection).
 * Our CLI packages describe a routing gateway; the squat package is an event emitter.
 */
function looksLikeOurPackage(meta, expectedName) {
  if (!meta?.version) return false;
  if (meta.name && expectedName && meta.name !== expectedName) return false;
  const desc = (meta.description || "").toLowerCase();
  // Known good markers for this product line
  if (
    /switchboard|9router|routing|router|openai|claude|gateway|model/.test(desc)
  ) {
    return true;
  }
  // If description is empty but name matches configured package, allow
  if (!desc && meta.name === expectedName) return true;
  return false;
}

export async function GET() {
  const currentVersion = pkg.version;
  const packageName = resolveNpmPackageName();

  if (!packageName) {
    return Response.json({
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      packageName: null,
      reason: "no_package_configured",
    });
  }

  const meta = await fetchLatestPackage(packageName);
  if (!meta?.version) {
    return Response.json({
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      packageName,
      reason: "registry_unavailable",
    });
  }

  if (!looksLikeOurPackage(meta, packageName)) {
    // Wrong package on npm (name collision) — never surface as an update
    return Response.json({
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      packageName,
      reason: "package_identity_mismatch",
    });
  }

  const latestVersion = meta.version;
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

  return Response.json({
    currentVersion,
    latestVersion,
    hasUpdate,
    packageName,
  });
}
