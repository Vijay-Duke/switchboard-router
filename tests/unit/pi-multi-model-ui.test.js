import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("Pi multi-model picker", () => {
  it("does not claim unsaved model selections are persisted", () => {
    const card = source("src/app/(dashboard)/dashboard/cli-tools/components/OpenAiCompatToolCard.js");
    const modal = source("src/shared/components/ModelSelectModal.js");

    expect(modal).not.toContain("Changes are saved automatically");
    expect(card).toContain("Select any number of models");
    expect(card).toContain("click Apply to save");
  });

  it("gives multi-select users a selected count and explicit completion action", () => {
    const modal = source("src/shared/components/ModelSelectModal.js");

    expect(modal).toContain('role="status"');
    expect(modal).toContain('aria-live="polite"');
    expect(modal).toContain("Done selecting");
  });
});
