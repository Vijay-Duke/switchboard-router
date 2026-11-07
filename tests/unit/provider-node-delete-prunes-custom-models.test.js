// Upstream a8f63f4d: deleting a compatible node must also drop its saved
// custom models, or they keep surfacing in /v1/models and pickers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-node-prune-"));
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;
const db = await import("../../src/lib/db/index.js");

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("deleteProviderNode", () => {
  it("removes only the deleted node's custom models", async () => {
    const node = await db.createProviderNode({ type: "openai-compatible", name: "Prune Me", prefix: "prune", baseUrl: "https://example.test/v1" });
    const other = await db.createProviderNode({ type: "openai-compatible", name: "Keep Me", prefix: "keep", baseUrl: "https://example.test/v1" });
    await db.addCustomModel({ providerAlias: node.id, id: "m1" });
    await db.addCustomModel({ providerAlias: node.id, id: "m2", type: "embedding" });
    await db.addCustomModel({ providerAlias: other.id, id: "m1" });
    await db.addCustomModel({ providerAlias: "openai", id: "gpt-x" });

    await db.deleteProviderNode(node.id);

    const left = (await db.getCustomModels()).map((m) => `${m.providerAlias}|${m.id}`);
    expect(left).not.toContain(`${node.id}|m1`);
    expect(left).not.toContain(`${node.id}|m2`);
    expect(left).toContain(`${other.id}|m1`);
    expect(left).toContain("openai|gpt-x");
  });
});
