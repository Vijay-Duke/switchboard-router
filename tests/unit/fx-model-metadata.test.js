import { describe, it, expect, vi } from "vitest";

vi.mock("yaml", () => ({
  parseDocument: () => ({ errors: [], hasIn: () => false, getIn: () => null, setIn: () => {}, deleteIn: () => {}, toString: () => "" }),
}));

import {
  buildFxModelMetadata,
  mergeFxSwitchboardSettings,
} from "../../src/lib/cli/modelCatalog.js";
import { createPiCapsResolver } from "../../src/lib/cli/piCapsResolverCore.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("buildFxModelMetadata", () => {
  it("maps registry caps to FX model_metadata fields", () => {
    const metadata = buildFxModelMetadata(
      ["muse/muse-spark-1.3-contributor"],
      () => ({
        reasoning: true,
        contextWindow: 200000,
        levels: getThinkingLevels("muse", "muse-spark-1.3-contributor"),
      }),
    );
    const base = metadata["muse/muse-spark-1.3-contributor"];
    expect(base.context_window).toBe(200000);
    expect(base.supports_tool_use).toBe(true);
    expect(base.max_output_tokens).toBeGreaterThan(0);
    expect(typeof base.supports_vision).toBe("boolean");
  });

  it("expands effort levels as distinct model IDs (no effort in metadata)", () => {
    const id = "surplus-deepseek/deepseek-v4.1-flash-1017";
    const levels = getThinkingLevels(null, "deepseek-v4.1-flash-1017");
    const metadata = buildFxModelMetadata([id], () => ({
      reasoning: true,
      levels,
    }));
    expect(metadata[id]).toBeDefined();
    expect(metadata[`${id}(high)`]).toEqual(metadata[id]);
    expect(metadata[`${id}(max)`]).toEqual(metadata[id]);
    expect(metadata[id].reasoning_effort).toBeUndefined();
    expect(Object.keys(metadata).sort()).toEqual([
      id,
      `${id}(high)`,
      `${id}(max)`,
    ].sort());
  });

  it("omits effort suffix IDs when the model does not reason", () => {
    const metadata = buildFxModelMetadata(["plain/model"], () => ({ reasoning: false }));
    expect(Object.keys(metadata)).toEqual(["plain/model"]);
  });
});

describe("mergeFxSwitchboardSettings", () => {
  it("merges switchboard provider without dropping unrelated providers", () => {
    const resolver = createPiCapsResolver();
    const merged = mergeFxSwitchboardSettings(
      {
        provider: "local",
        providers: { local: { protocol: "openai-chat-completions", base_url: "http://127.0.0.1:1/v1" } },
        models: { local: "m" },
      },
      {
        baseUrl: "http://localhost:20128/v1",
        models: ["cc/claude-sonnet-5"],
        defaultModel: "cc/claude-sonnet-5",
        capsResolver: resolver,
      },
    );
    expect(merged.provider).toBe("switchboard");
    expect(merged.providers.local).toBeDefined();
    expect(merged.providers.switchboard.protocol).toBe("openai-chat-completions");
    expect(merged.providers.switchboard.auth).toEqual({ type: "bearer", env: "FX_SWITCHBOARD_API_KEY" });
    expect(merged.models.switchboard).toBe("cc/claude-sonnet-5");
    expect(merged.providers.switchboard.model_metadata["cc/claude-sonnet-5"]).toBeDefined();
  });
});
