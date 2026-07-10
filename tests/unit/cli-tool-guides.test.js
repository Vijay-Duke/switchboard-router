import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";

const context = {
  baseUrl: "http://127.0.0.1:20128/v1",
  apiKey: "sk-secret",
  model: "cx/gpt-5.6",
  models: ["cx/gpt-5.6", "cc/claude-sonnet-5"],
};

describe("CLI multi-model guides", () => {
  it("generates a current Continue YAML model list", () => {
    const parsed = parseYaml(CLI_TOOLS.continue.codeBlock.code(context));
    expect(parsed.models.map((model) => model.model)).toEqual(context.models);
    expect(parsed.models.every((model) => model.roles.includes("chat"))).toBe(true);
  });

  it("generates Qwen's provider registry without persisting the selected API key", () => {
    const config = JSON.parse(CLI_TOOLS.qwen.codeBlock.code(context));
    expect(config.modelProviders.openai.models.map((model) => model.id)).toEqual(context.models);
    expect(config.modelProviders.openai.models.every((model) => model.envKey === "SWITCHBOARD_API_KEY")).toBe(true);
    expect(JSON.stringify(config)).not.toContain(context.apiKey);
  });

  it("uses repeatable model selection for Cursor and OpenAI-compatible profiles for Roo", () => {
    expect(CLI_TOOLS.cursor.modelSelection).toBe("multiple");
    expect(CLI_TOOLS.roo.modelSelection).toBe("multiple");
    expect(JSON.stringify(CLI_TOOLS.roo.guideSteps)).toContain("OpenAI Compatible");
    expect(JSON.stringify(CLI_TOOLS.roo.guideSteps)).not.toContain("Ollama");
  });

  it("does not advertise unsupported Amp or fake Copilot CLI configuration", () => {
    expect(CLI_TOOLS.amp).toBeUndefined();
    expect(CLI_TOOLS.copilot).toBeUndefined();
  });
});
