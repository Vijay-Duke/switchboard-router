// O16: every accepted ?tab value has a matching SegmentedControl option.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../src/app/(dashboard)/dashboard/usage/page.js"),
  "utf8",
);

describe("usage tabs (O16)", () => {
  it("accepted tab values all have a visible option", () => {
    const accepted = src.match(/\[("[a-z]+"(?:,\s*"[a-z]+")*)\]\.includes\(tabFromUrl\)/);
    expect(accepted).not.toBeNull();
    const values = accepted[1].split(",").map((v) => v.trim().replace(/"/g, ""));
    for (const value of values) {
      expect(src).toContain(`{ value: "${value}", label:`);
    }
  });
});
