import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-model-routing-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const { createCombo, createProviderNode } = await import("@/models/index.js");
  const { getComboModels, getModelInfo } = await import("@/sse/services/model.js");
  const { encodeClaudeCatalogModelId } = await import("@/shared/claudeGateway.js");

  return {
    createCombo,
    createProviderNode,
    encodeClaudeCatalogModelId,
    getComboModels,
    getModelInfo,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("model routing", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("keeps built-in provider aliases ahead of compatible node prefixes", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-test",
      type: "openai-compatible",
      name: "Compatible CF Collision",
      prefix: "cf",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    await expect(ctx.getModelInfo("cf/@cf/black-forest-labs/flux-2-klein-9b"))
      .resolves.toEqual({
        provider: "cloudflare-ai",
        model: "@cf/black-forest-labs/flux-2-klein-9b",
      });
  });

  it("still routes non-reserved compatible node prefixes", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-test",
      type: "openai-compatible",
      name: "Compatible OCT",
      prefix: "oct",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    await expect(ctx.getModelInfo("oct/gpt-image-1"))
      .resolves.toEqual({
        provider: "openai-compatible-chat-test",
        model: "gpt-image-1",
      });
  });

  it("routes reversible Claude catalog IDs to provider models and combos", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    const providerModel = ctx.encodeClaudeCatalogModelId("openai/gpt-5.6");
    expect(providerModel).toBe("claude-switchboard-v1/openai/gpt-5.6");
    await expect(ctx.getModelInfo(providerModel)).resolves.toEqual({
      provider: "openai",
      model: "gpt-5.6",
    });

    await ctx.createCombo({
      name: "coding-auto",
      models: ["openai/gpt-5.6", "gemini/gemini-3.1-pro"],
    });
    const comboModel = ctx.encodeClaudeCatalogModelId("coding-auto");
    expect(comboModel).toBe("claude-switchboard-v1/coding-auto");
    await expect(ctx.getComboModels(comboModel)).resolves.toEqual([
      "openai/gpt-5.6",
      "gemini/gemini-3.1-pro",
    ]);
  });
});
