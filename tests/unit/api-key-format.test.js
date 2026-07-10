import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dataDir;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  dataDir = null;
});

describe("API key format", () => {
  it("uses a 128-bit random key id while preserving parse compatibility", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "switchboard-api-key-"));
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("API_KEY_SECRET", "test-only-secret");
    const { generateApiKeyWithMachine, parseApiKey, verifyApiKeyCrc } = await import(
      "../../src/shared/utils/apiKey.js"
    );

    const generated = generateApiKeyWithMachine("machine123456789");
    expect(generated.keyId).toMatch(/^[a-f0-9]{32}$/);
    expect(parseApiKey(generated.key)).toEqual({
      machineId: "machine123456789",
      keyId: generated.keyId,
      isNewFormat: true,
    });
    expect(verifyApiKeyCrc(generated.key)).toBe(true);
  });
});
