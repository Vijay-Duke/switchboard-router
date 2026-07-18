import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("compatible provider removed models", () => {
  it("keeps removed models hidden but offers an explicit enable action", () => {
    const source = fs.readFileSync(
      path.join(
        repoRoot,
        "src/app/(dashboard)/dashboard/providers/[id]/CompatibleModelsSection.js",
      ),
      "utf8",
    );

    expect(source).toContain("Removed models (");
    expect(source).toContain("onEnableModel?.(modelId)");
    expect(source).toContain("Enable a model to make it available");
  });
});
