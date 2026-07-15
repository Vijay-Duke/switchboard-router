// Switchboard tray binary resolver.
// Uses platform-specific optionalDependencies (esbuild/swc pattern).
// Each platform has its own npm package containing only that architecture's binary.
// Falls back to downloading from GitHub releases if optionalDeps are missing.
const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");

const BINARY_NAME = "switchboard-tray";
const TRAY_VERSION = "1.0.0";
const GITHUB_REPO = "Vijay-Duke/switchboard-router";

// Platform → package name mapping
const PLATFORM_PACKAGES = {
  "darwin-arm64": "switchboard-tray-darwin-arm64",
  "darwin-x64": "switchboard-tray-darwin-x64",
  "linux-x64": "switchboard-tray-linux-x64",
};

/**
 * Get the platform-specific package name for the current system.
 */
function getPlatformPackage() {
  const key = `${process.platform}-${process.arch}`;
  return PLATFORM_PACKAGES[key] || null;
}

/**
 * Try to resolve the tray binary from the optionalDependency package.
 * Returns the binary path if found, null otherwise.
 */
function resolveBinaryFromPackage() {
  const pkg = getPlatformPackage();
  if (!pkg) return null;

  try {
    // resolve from the installed optionalDependency
    const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
    const binPath = path.join(pkgDir, "bin", BINARY_NAME);
    if (fs.existsSync(binPath)) {
      return binPath;
    }
  } catch {
    // Package not installed (--ignore-optional or install failure)
  }
  return null;
}

/**
 * Fallback: check if the binary was downloaded by postinstall into ~/.switchboard/runtime/bin/
 */
function resolveBinaryFromCache() {
  const cacheDir = path.join(
    process.env.SWITCHBOARD_DATA_DIR || path.join(require("os").homedir(), ".switchboard"),
    "runtime", "bin"
  );
  const binPath = path.join(cacheDir, BINARY_NAME);
  if (fs.existsSync(binPath)) {
    return binPath;
  }
  return null;
}

/**
 * Download the tray binary from GitHub releases as a last resort.
 * Stores it in ~/.switchboard/runtime/bin/
 */
async function downloadBinaryFallback({ silent = false } = {}) {
  const pkg = getPlatformPackage();
  if (!pkg) return null;

  const cacheDir = path.join(
    process.env.SWITCHBOARD_DATA_DIR || path.join(require("os").homedir(), ".switchboard"),
    "runtime", "bin"
  );
  fs.mkdirSync(cacheDir, { recursive: true });
  const destPath = path.join(cacheDir, BINARY_NAME);

  // Download the platform package tarball from npm and extract the binary
  const tarballUrl = `https://registry.npmjs.org/${pkg}/-/${pkg}-${TRAY_VERSION}.tgz`;
  if (!silent) console.log(`⏳ Downloading tray binary from npm (${pkg})...`);

  try {
    const tarball = await httpGet(tarballUrl);
    const extracted = extractFileFromTarball(zlib.gunzipSync(tarball), `package/bin/${BINARY_NAME}`);
    if (!extracted) {
      if (!silent) console.warn("⚠️  Failed to extract tray binary from tarball");
      return null;
    }
    fs.writeFileSync(destPath, extracted, { mode: 0o755 });
    if (!silent) console.log("✅ Tray binary downloaded");
    return destPath;
  } catch (err) {
    if (!silent) console.warn(`⚠️  Tray binary download failed: ${err.message}`);
    return null;
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function extractFileFromTarball(tarBuffer, filepath) {
  let offset = 0;
  while (offset < tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    offset += 512;
    const fileName = header.toString("utf-8", 0, 100).replace(/\0.*/g, "");
    const fileSize = parseInt(header.toString("utf-8", 124, 136).replace(/\0.*/g, ""), 8);
    if (isNaN(fileSize)) break;
    if (fileName === filepath) {
      return tarBuffer.subarray(offset, offset + fileSize);
    }
    offset = (offset + fileSize + 511) & ~511;
  }
  return null;
}

// Remove legacy systray/systray2 from runtime dir if present
function cleanupLegacySystray({ silent = false } = {}) {
  const { getRuntimeNodeModules } = require("./sqliteRuntime");
  const targets = [
    path.join(getRuntimeNodeModules(), "systray"),
    path.join(getRuntimeNodeModules(), "systray2"),
  ];
  for (const dir of targets) {
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        if (!silent) console.log(`[switchboard] removed legacy tray package: ${path.basename(dir)}`);
      } catch {}
    }
  }
}

/**
 * Resolve the tray binary path. Tries in order:
 * 1. optionalDependency package (installed by npm)
 * 2. Cached binary from previous download
 * 3. null (caller can trigger async download fallback)
 */
function getTrayBinPath() {
  return resolveBinaryFromPackage() || resolveBinaryFromCache() || null;
}

/**
 * Ensure the tray runtime is available. Called during postinstall or first run.
 */
function ensureTrayRuntime({ silent = false } = {}) {
  cleanupLegacySystray({ silent });

  if (process.platform === "win32") {
    return { systray: false, skipped: true };
  }

  const binPath = getTrayBinPath();
  if (binPath) {
    // Ensure executable bit
    try { fs.chmodSync(binPath, 0o755); } catch {}
    if (!silent) console.log("✅ System tray ready");
    return { systray: true, binPath };
  }

  if (!silent) console.log("ℹ️  Tray binary not found (optionalDependency may have been skipped). Will download on first use.");
  return { systray: false, needsDownload: true };
}

module.exports = { ensureTrayRuntime, getTrayBinPath, downloadBinaryFallback, getPlatformPackage };

