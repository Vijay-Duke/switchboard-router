// Upstream 38f031f4: addCustomModel upserts — re-adding updates caps/name in
// place without resetting omitted fields (e.g. a captured reasoning descriptor).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-custom-caps-"));
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

describe("addCustomModel caps upsert", () => {
  it("stores caps on first add", async () => {
    const added = await db.addCustomModel({
      providerAlias: "ollama", id: "vision-model", type: "llm",
      caps: { vision: true, reasoning: false },
    });
    expect(added).toBe(true);
    const models = await db.getCustomModels();
    const m = models.find((x) => x.providerAlias === "ollama" && x.id === "vision-model");
    expect(m.caps).toEqual({ vision: true, reasoning: false });
  });

  it("upserts caps and name without resetting omitted fields", async () => {
    await db.addCustomModel({
      providerAlias: "ollama", id: "reasoning-model",
      reasoning: { format: "reasoning_content", effort: true },
      caps: { vision: false, reasoning: false },
    });
    const added = await db.addCustomModel({
      providerAlias: "ollama", id: "reasoning-model", name: "Renamed",
      caps: { vision: false, reasoning: true },
    });
    expect(added).toBe(false); // updated, not newly added
    const models = await db.getCustomModels();
    const m = models.find((x) => x.providerAlias === "ollama" && x.id === "reasoning-model");
    expect(m.name).toBe("Renamed");
    expect(m.caps).toEqual({ vision: false, reasoning: true });
    expect(m.reasoning).toEqual({ format: "reasoning_content", effort: true });
  });

  it("leaves an existing entry untouched when neither caps nor name is passed", async () => {
    await db.addCustomModel({ providerAlias: "cc", id: "keep-me", name: "Original", caps: { vision: true, reasoning: true } });
    await db.addCustomModel({ providerAlias: "cc", id: "keep-me" });
    const models = await db.getCustomModels();
    const m = models.find((x) => x.providerAlias === "cc" && x.id === "keep-me");
    expect(m.name).toBe("Original");
    expect(m.caps).toEqual({ vision: true, reasoning: true });
  });
});
