import { describe, expect, it } from "vitest";
import { buildAiderManualConfigs } from "../../src/app/(dashboard)/dashboard/cli-tools/components/AiderToolCard.js";

const ctx = {
  baseUrl: "http://127.0.0.1:20128/v1",
  apiKey: "sk_switchboard",
  model: "provider/model-a",
  models: [],
};

function aliasesFor(models) {
  const [{ content }] = buildAiderManualConfigs({ ...ctx, models });
  return content
    .split("\n")
    .filter((line) => /^\s*- switchboard-/.test(line))
    .map((line) => line.split(":")[0].replace(/^\s*-\s*/, ""));
}

describe("aider manual config aliases (T21)", () => {
  it("disambiguates slug collisions with -2/-3 like modelCatalog.buildAiderAliases", () => {
    // `a/b-c` and `a/b_c` both slug to a-b-c.
    const aliases = aliasesFor(["a/b-c", "a/b_c", "a/b-c-d"]);
    expect(aliases).toEqual([
      "switchboard-a-b-c",
      "switchboard-a-b-c-2",
      "switchboard-a-b-c-d",
    ]);
  });

  it("keeps distinct slugs unsuffixed", () => {
    const aliases = aliasesFor(["openai/gpt-5", "anthropic/claude-sonnet-5"]);
    expect(aliases).toEqual(["switchboard-openai-gpt-5", "switchboard-anthropic-claude-sonnet-5"]);
  });
});
