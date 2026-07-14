import { describe, expect, it } from "vitest";
import { readClaudeModelMappings } from "../../src/app/(dashboard)/dashboard/cli-tools/components/claudeSettingsForm.js";

const models = [
  { alias: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL", defaultValue: "cc/claude-opus-4-8" },
  { alias: "sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL", defaultValue: "cc/claude-sonnet-5" },
];

describe("Claude Code settings form", () => {
  it("shows restored file values instead of substituting cc/* defaults", () => {
    expect(readClaudeModelMappings(models, {
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/previous-opus" },
    })).toEqual({
      opus: "anthropic/previous-opus",
      sonnet: "",
    });
  });

  it("leaves model fields empty when the file has no model overrides", () => {
    expect(readClaudeModelMappings(models, { env: {} })).toEqual({
      opus: "",
      sonnet: "",
    });
  });
});
