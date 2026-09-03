// Switchboard tray binary resolver.
// Uses platform-specific optionalDependencies (esbuild/swc pattern).
// Each platform has its own npm package containing only that architecture's binary.
// Falls back to downloading from GitHub releases if optionalDeps are missing.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const { getDataDir } = require("../src/shared/dataDir");

const BINARY_NAME = "switchboard-tray";
const TRAY_VERSION = "1.0.0";
const GITHUB_REPO = "Vijay-Duke/switchboard-router";
// Upper bound for any single registry response body we buffer in memory.
const TARBALL_MAX_BYTES = 32 * 1024 * 1024;
const METADATA_MAX_BYTES = 1024 * 1024;

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
 * Fallback: check if the binary was downloaded by postinstall into <DATA_DIR>/runtime/bin/
 */
function resolveBinaryFromCache() {
  const cacheDir = path.join(getDataDir(), "runtime", "bin");
  const binPath = path.join(cacheDir, BINARY_NAME);
  if (fs.existsSync(binPath)) {
    return binPath;
  }
  return null;
}

/**
 * Fetch the registry-recorded sha512 integrity for the platform tarball.
 * Returns null when the metadata is missing or unusable (fail closed).
 */
async function fetchTarballIntegrity(pkg) {
  const metaUrl = `https://registry.npmjs.org/${pkg}/${TRAY_VERSION}`;
  const body = await module.exports.httpGet(metaUrl, { maxBytes: METADATA_MAX_BYTES });
  let meta;
  try {
    meta = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  const integrity = meta && meta.dist && meta.dist.integrity;
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) return null;
  return integrity;
}

/**
 * Verify the downloaded tarball against the registry-recorded integrity
 * (`sha512-<base64>`). Throws on mismatch — the bytes must never be executed.
 */
function verifyTarballIntegrity(tarball, integrity) {
  let expected;
  try {
    expected = Buffer.from(integrity.slice("sha512-".length), "base64");
  } catch {
    throw new Error("tray tarball has an unparseable integrity value");
  }
  const actual = crypto.createHash("sha512").update(tarball).digest();
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error("tray tarball integrity mismatch; refusing to install");
  }
}

/**
 * Download the tray binary from the npm registry as a last resort.
 * Stores it in <DATA_DIR>/runtime/bin/. The tarball is verified against the
 * registry metadata integrity before anything is written or executed.
 */
async function downloadBinaryFallback({ silent = false } = {}) {
  const pkg = getPlatformPackage();
  if (!pkg) return null;

  const cacheDir = path.join(getDataDir(), "runtime", "bin");
  fs.mkdirSync(cacheDir, { recursive: true });
  const destPath = path.join(cacheDir, BINARY_NAME);

  // Download the platform package tarball from npm and extract the binary
  const tarballUrl = `https://registry.npmjs.org/${pkg}/-/${pkg}-${TRAY_VERSION}.tgz`;
  if (!silent) console.log(`⏳ Downloading tray binary from npm (${pkg})...`);

  try {
    const integrity = await fetchTarballIntegrity(pkg);
    if (!integrity) {
      if (!silent) console.warn("⚠️  Tray metadata has no usable integrity; refusing download");
      return null;
    }
    const tarball = await module.exports.httpGet(tarballUrl, { maxBytes: TARBALL_MAX_BYTES });
    verifyTarballIntegrity(tarball, integrity);
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

function httpGet(url, { maxBytes = TARBALL_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return module.exports.httpGet(res.headers.location, { maxBytes }).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      let rejected = false;
      res.on("data", (c) => {
        if (rejected) return;
        size += c.length;
        if (size > maxBytes) {
          rejected = true;
          try { res.destroy(); } catch { /* best effort */ }
          reject(new Error(`response exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        if (!rejected) resolve(Buffer.concat(chunks));
      });
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

module.exports = { ensureTrayRuntime, getTrayBinPath, downloadBinaryFallback, getPlatformPackage, httpGet };

