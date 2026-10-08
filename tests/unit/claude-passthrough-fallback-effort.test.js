import { describe, expect, it } from "vitest";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";

describe("Claude passthrough model fallback effort isolation", () => {
  const request = () => ({
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: { type: "object", properties: {} } },
    },
    messages: [{ role: "user", content: "Return a JSON object" }],
  });

  it("strips unsupported Haiku effort without changing the shared request", () => {
    const original = request();
    const snapshot = structuredClone(original);
    const translated = normalizeClaudePassthrough({ ...original }, "claude-haiku-5-5");
    expect(translated.output_config).toEqual({ format: snapshot.output_config.format });
    expect(original).toEqual(snapshot);
  });

  it("retains the requested effort on an Opus attempt after Haiku", () => {
    const original = request();
    normalizeClaudePassthrough({ ...original }, "claude-haiku-5-5");
    const opus = normalizeClaudePassthrough({ ...original }, "claude-opus-5-5");
    expect(opus.output_config.effort).toBe("high");
    expect(opus.thinking).toEqual({ type: "adaptive" });
  });

  it("removes an empty Haiku output_config without removing effort for retry", () => {
    const original = { ...request(), output_config: { effort: "high" } };
    const translated = normalizeClaudePassthrough({ ...original }, "claude-haiku-5-5");
    expect(translated.output_config).toBeUndefined();
    expect(original.output_config).toEqual({ effort: "high" });
  });
});
