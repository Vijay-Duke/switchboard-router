import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("OAuth modal secret handling", () => {
  it("does not serialize client secrets into the authorize URL", () => {
    const source = fs.readFileSync(new URL("../../src/shared/components/OAuthModal.js", import.meta.url), "utf8");
    expect(source).toContain('k !== "clientSecret"');
  });
});
