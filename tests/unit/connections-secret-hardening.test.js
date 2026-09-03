import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { redactSecrets } from "../../src/lib/db/repos/connectionsRepo.js";

const origDataDir = process.env.DATA_DIR;

afterEach(() => {
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  vi.resetModules();
});

describe("connection secret redaction", () => {
  it("does not expose non-string secret values", () => {
    const redacted = redactSecrets({ apiKey: 123456, providerSpecificData: { refreshToken: false } });
    expect(redacted.apiKey).toBeUndefined();
    expect(redacted.providerSpecificData.refreshToken).toBeUndefined();
  });

  it("seals enc:v2 with auth/cli-secret mixed in while enc:v1 blobs stay readable (C5)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-secret-"));
    try {
      process.env.DATA_DIR = dir;
      vi.resetModules();
      const secrets = await import("../../src/lib/crypto/secrets.js");
      const authDir = path.join(dir, "auth");
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, "cli-secret"), "secret-one", { mode: 0o600 });
      const v2 = secrets.encryptSecret("s3cr3t-value");
      expect(v2).toMatch(/^enc:v2:/);
      expect(secrets.decryptSecret(v2)).toBe("s3cr3t-value");
      expect(secrets.encryptSecret(v2)).toBe(v2);

      // A pre-upgrade blob: sealed with the bare data-key the module persisted.
      const dataKey = fs.readFileSync(path.join(authDir, "data-key"));
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
      const ct = Buffer.concat([cipher.update("legacy-value", "utf8"), cipher.final()]);
      const v1 = `enc:v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ct.toString("hex")}`;
      expect(secrets.decryptSecret(v1)).toBe("legacy-value");
      expect(secrets.encryptSecret(v1)).toBe(v1);

      // Rotated cli-secret: v2 under the old secret is "not set"; v1 is unaffected.
      secrets.__resetSecretsKeyForTests();
      fs.writeFileSync(path.join(authDir, "cli-secret"), "secret-two");
      expect(secrets.decryptSecret(v2)).toBeNull();
      expect(secrets.decryptSecret(v1)).toBe("legacy-value");
      const resealed = secrets.encryptSecret("s3cr3t-value");
      expect(resealed).toMatch(/^enc:v2:/);
      expect(secrets.decryptSecret(resealed)).toBe("s3cr3t-value");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates auth/cli-secret itself when absent so non-CLI runtimes seal v2 (C5)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-secret-"));
    try {
      process.env.DATA_DIR = dir;
      vi.resetModules();
      const secrets = await import("../../src/lib/crypto/secrets.js");
      const sealed = secrets.encryptSecret("fresh-install");
      expect(sealed).toMatch(/^enc:v2:/);
      const secretFile = path.join(dir, "auth", "cli-secret");
      expect(fs.readFileSync(secretFile, "utf8")).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
      expect(secrets.decryptSecret(sealed)).toBe("fresh-install");
      // A fresh module instance (e.g. next server start) reads the same secret back.
      vi.resetModules();
      const again = await import("../../src/lib/crypto/secrets.js");
      expect(again.decryptSecret(sealed)).toBe("fresh-install");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
