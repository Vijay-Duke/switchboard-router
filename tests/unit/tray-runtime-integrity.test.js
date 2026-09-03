// The tray binary fallback downloads and executes a native binary, so the
// tarball must be verified against the registry-recorded integrity before
// anything lands on disk.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const trayRuntime = require("../../cli/hooks/trayRuntime.js");

const PLATFORM_PKG = trayRuntime.getPlatformPackage();
const BINARY_NAME = "switchboard-tray";
const BINARY_CONTENT = Buffer.from("fake-tray-binary-bytes");

function buildTar(files) {
  const parts = [];
  for (const [name, content] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000777", 100, "utf8");
    header.write("0000000", 108, "utf8");
    header.write("0000000", 116, "utf8");
    header.write(content.length.toString(8).padStart(11, "0"), 124, "utf8");
    header.write("00000000000", 136, "utf8");
    header.write("        ", 148, "utf8");
    header.write("0", 156, "utf8");
    header.write("ustar", 257, "utf8");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
    parts.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024)); // end-of-archive zero blocks
  return Buffer.concat(parts);
}

function sha512Integrity(bytes) {
  return `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
}

describe.skipIf(!PLATFORM_PKG)("tray binary fallback integrity", () => {
  let dataDir;
  let originalDataDir;
  let originalHttpGet;
  let announcedIntegrity;

  const tarballBytes = zlib.gzipSync(buildTar({ [`package/bin/${BINARY_NAME}`]: BINARY_CONTENT }));

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-tray-integrity-"));
    process.env.DATA_DIR = dataDir;
    originalHttpGet = trayRuntime.httpGet;
    announcedIntegrity = sha512Integrity(tarballBytes);
    trayRuntime.httpGet = async (url) => {
      if (String(url).endsWith(".tgz")) return tarballBytes;
      return Buffer.from(JSON.stringify({ dist: { integrity: announcedIntegrity } }));
    };
  });

  afterEach(() => {
    trayRuntime.httpGet = originalHttpGet;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a tarball whose bytes do not match the registry integrity", async () => {
    announcedIntegrity = sha512Integrity(Buffer.from("different-bytes"));

    const result = await trayRuntime.downloadBinaryFallback({ silent: true });

    expect(result).toBeNull();
    expect(fs.existsSync(path.join(dataDir, "runtime", "bin", BINARY_NAME))).toBe(false);
  });

  it("installs a tarball whose bytes match the registry integrity", async () => {
    const result = await trayRuntime.downloadBinaryFallback({ silent: true });
    const destPath = path.join(dataDir, "runtime", "bin", BINARY_NAME);

    expect(result).toBe(destPath);
    expect(fs.readFileSync(destPath)).toEqual(BINARY_CONTENT);
  });

  it("refuses when the registry metadata fetch fails", async () => {
    trayRuntime.httpGet = async (url) => {
      if (String(url).endsWith(".tgz")) return tarballBytes;
      throw new Error("HTTP 503");
    };

    const result = await trayRuntime.downloadBinaryFallback({ silent: true });

    expect(result).toBeNull();
    expect(fs.existsSync(path.join(dataDir, "runtime", "bin", BINARY_NAME))).toBe(false);
  });

  it("refuses when the registry metadata has no usable integrity", async () => {
    trayRuntime.httpGet = async (url) => {
      if (String(url).endsWith(".tgz")) return tarballBytes;
      return Buffer.from(JSON.stringify({ dist: {} }));
    };

    const result = await trayRuntime.downloadBinaryFallback({ silent: true });

    expect(result).toBeNull();
    expect(fs.existsSync(path.join(dataDir, "runtime", "bin", BINARY_NAME))).toBe(false);
  });
});
