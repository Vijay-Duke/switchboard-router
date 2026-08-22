import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const componentDir = path.join(root, "src/app/(dashboard)/dashboard/cli-tools/components");
const files = fs.readdirSync(componentDir).filter((name) => name.endsWith(".js"));

describe("safe client key consumers", () => {
  it("never reads a reusable key from list records", () => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(componentDir, file), "utf8");
      expect(source, file).not.toMatch(/apiKeys(?:\?\.)?\s*\[?[^\n]*?\.key\b/);
      expect(source, file).not.toMatch(/\b(?:k|key|savedKey)\.key\b/);
    }
  });

  it("renders list metadata as prefixes and requires custom secret input", () => {
    const select = fs.readFileSync(path.join(componentDir, "ApiKeySelect.js"), "utf8");
    expect(select).toContain("keyPrefix");
    expect(select).toContain("Custom secret");
    expect(select).not.toContain("value={k.key}");
  });
});
