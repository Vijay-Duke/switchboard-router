import { describe, expect, it } from "vitest";
import { getProviderByAlias, resolveProviderId } from "../../src/shared/constants/providers.js";

describe("provider aliases", () => {
  it("normalizes the legacy ClinePass provider alias for CLI model pickers", () => {
    expect(resolveProviderId("cline-pass")).toBe("clinepass");
    expect(getProviderByAlias("cline-pass")?.id).toBe("clinepass");
  });
});
