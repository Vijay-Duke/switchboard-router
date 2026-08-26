import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-auth-strategy-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("getProviderCredentials strategy selection", () => {
  it("selects top priority account under fill-first and spills over when excluded", async () => {
    const { createProviderConnection, updateSettings } = await import("../../src/lib/db/index.js");
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

    await updateSettings({
      providerStrategies: {
        openrouter: { fallbackStrategy: "fill-first" },
      },
    });

    const c1 = await createProviderConnection({
      provider: "openrouter",
      name: "Account 1",
      authType: "apikey",
      apiKey: "sk-or-1",
      priority: 1,
      isActive: true,
    });
    const c2 = await createProviderConnection({
      provider: "openrouter",
      name: "Account 2",
      authType: "apikey",
      apiKey: "sk-or-2",
      priority: 2,
      isActive: true,
    });

    // 1. Initial request selects top priority account (c1)
    const sel1 = await getProviderCredentials("openrouter");
    expect(sel1.connectionId).toBe(c1.id);
    expect(sel1.selectionReason).toBe("fill-first");

    // 2. When c1 is excluded (e.g. rate limit retry), spills over to c2
    const sel2 = await getProviderCredentials("openrouter", new Set([c1.id]));
    expect(sel2.connectionId).toBe(c2.id);
    expect(sel2.selectionReason).toBe("fill-first");
  });

  it("rotates across accounts under round-robin strategy", async () => {
    const { createProviderConnection, updateSettings } = await import("../../src/lib/db/index.js");
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

    await updateSettings({
      providerStrategies: {
        deepseek: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 },
      },
    });

    const c1 = await createProviderConnection({
      provider: "deepseek",
      name: "DS 1",
      authType: "apikey",
      apiKey: "sk-ds-1",
      priority: 1,
      isActive: true,
    });
    const c2 = await createProviderConnection({
      provider: "deepseek",
      name: "DS 2",
      authType: "apikey",
      apiKey: "sk-ds-2",
      priority: 2,
      isActive: true,
    });

    const sel1 = await getProviderCredentials("deepseek");
    expect(sel1.selectionReason).toBe("round-robin");
    expect(sel1.connectionId).toBe(c1.id);

    const sel2 = await getProviderCredentials("deepseek");
    expect(sel2.selectionReason).toBe("round-robin");
    expect(sel2.connectionId).toBe(c2.id);
  });
});
