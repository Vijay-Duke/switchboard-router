// @ts-check
// T116: skill URL builders must encode ids so space/slash ids don't split the path.
import { describe, expect, it } from "vitest";
import { getSkillRawUrl, getSkillBlobUrl } from "../../src/shared/constants/skills.js";

describe("skills URL builders (T116)", () => {
  it("encodes ids with spaces and slashes in the raw URL", () => {
    expect(getSkillRawUrl("a b/c")).toBe("/api/skills/a%20b%2Fc");
  });

  it("encodes ids with spaces and slashes in the viewer URL", () => {
    expect(getSkillBlobUrl("a b/c")).toBe("/dashboard/skills/a%20b%2Fc");
  });

  it("leaves plain ids unchanged", () => {
    expect(getSkillRawUrl("switchboard-chat")).toBe("/api/skills/switchboard-chat");
    expect(getSkillBlobUrl("switchboard")).toBe("/dashboard/skills/switchboard");
  });
});
