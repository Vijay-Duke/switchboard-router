import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/sse/services/compatibleReasoning.js", () => ({
  lookupCompatibleReasoningSupport: () => ({ supported: true, effort: "flat" }),
}));

import { createPiCapsResolver } from "../../src/lib/cli/piCapsResolverCore.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("createPiCapsResolver with compatible reasoning", () => {
  it("preserves registry thinking levels when the node is flat-compatible", () => {
    const id = "surplus-deepseek/deepseek-v4.1-flash-1017";
    const resolver = createPiCapsResolver();
    const caps = resolver(id);
    expect(caps?.reasoning).toBe(true);
    expect(caps?.levels).toEqual(getThinkingLevels(null, "deepseek-v4.1-flash-1017"));
    expect(caps?.levels).toContain("max");
  });
});
