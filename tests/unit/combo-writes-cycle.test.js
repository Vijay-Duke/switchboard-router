import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let comboWrites;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-combo-cycle-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  comboWrites = await import("@/lib/combos/comboWrites.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("combo write nesting validation", () => {
  it("rejects direct self-reference", async () => {
    await expect(comboWrites.assertNoComboCycle("self-ref", ["self-ref"]))
      .rejects.toMatchObject({
        name: "ComboWriteError",
        status: 400,
        message: 'Combo "self-ref" cannot contain itself',
      });
  });

  it("rejects a transitive cycle during an update", async () => {
    const b = await db.createCombo({ name: "cycle-b", models: ["openai/y"] });
    await comboWrites.createComboWrite({ name: "cycle-a", models: ["cycle-b"] });

    await expect(comboWrites.updateComboWrite(b.id, { models: ["cycle-a"] }))
      .rejects.toMatchObject({
        name: "ComboWriteError",
        status: 400,
        message: "Combo cycle detected: cycle-b → cycle-a → cycle-b",
      });
  });

  it("accepts valid nested combos during creation", async () => {
    await db.createCombo({ name: "valid-b", models: ["openai/y"] });

    await expect(comboWrites.createComboWrite({
      name: "valid-a",
      models: ["valid-b", "openai/x"],
    })).resolves.toMatchObject({
      name: "valid-a",
      models: ["valid-b", "openai/x"],
    });
  });

  it("rejects nesting deeper than the configured maximum", async () => {
    await db.createCombo({ name: "depth-b", models: ["depth-c"] });
    await db.createCombo({ name: "depth-c", models: ["depth-d"] });
    await db.createCombo({ name: "depth-d", models: ["openai/z"] });

    await expect(comboWrites.assertNoComboCycle("depth-a", ["depth-b"]))
      .rejects.toMatchObject({
        name: "ComboWriteError",
        status: 400,
        message: "Combo nesting too deep (>3): depth-a → depth-b → depth-c → depth-d",
      });
  });

  it("rejects a cycle introduced by a rename-only update", async () => {
    await db.createCombo({ name: "ren-p", models: ["ren-q"] });
    const z = await db.createCombo({ name: "ren-z", models: ["ren-p"] });
    // Renaming ren-z → ren-q (no models change) closes the loop ren-p → ren-q → ren-p.
    await expect(comboWrites.updateComboWrite(z.id, { name: "ren-q" }))
      .rejects.toMatchObject({
        name: "ComboWriteError",
        status: 400,
        message: "Combo cycle detected: ren-q → ren-p → ren-q",
      });
  });

  it("rejects an over-deep diamond even when a shallow branch reaches the node first", async () => {
    await db.createCombo({ name: "dia-a", models: ["dia-d"] }); // shallow: root→a→d = depth 3
    await db.createCombo({ name: "dia-b", models: ["dia-c"] });
    await db.createCombo({ name: "dia-c", models: ["dia-d"] }); // deep: root→b→c→d = depth 4
    await db.createCombo({ name: "dia-d", models: ["openai/z"] });

    await expect(comboWrites.assertNoComboCycle("dia-root", ["dia-a", "dia-b"]))
      .rejects.toMatchObject({
        name: "ComboWriteError",
        status: 400,
        message: "Combo nesting too deep (>3): dia-root → dia-b → dia-c → dia-d",
      });
  });

  it("serializes concurrent writes so a joint cycle cannot slip through", async () => {
    const a = await db.createCombo({ name: "race-a", models: ["openai/x"] });
    const b = await db.createCombo({ name: "race-b", models: ["openai/y"] });
    // A→B and B→A fired together: without serialization both validate against the
    // pre-write graph and jointly persist a cycle. With the write lock, the second
    // sees the first's committed edge and is rejected.
    const results = await Promise.allSettled([
      comboWrites.updateComboWrite(a.id, { models: ["race-b"] }),
      comboWrites.updateComboWrite(b.id, { models: ["race-a"] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ name: "ComboWriteError" });
  });

  it("accepts a leaf-only models list", async () => {
    await expect(comboWrites.createComboWrite({
      name: "leaf-only",
      models: ["openai/x", "anthropic/y"],
    })).resolves.toMatchObject({
      name: "leaf-only",
      models: ["openai/x", "anthropic/y"],
    });
  });
});
