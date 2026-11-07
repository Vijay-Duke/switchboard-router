// DeepSeek's /anthropic/v1/messages whitelists tool `type` to web_search_*
// and 400s "unknown variant `custom`" on typed client tools, while accepting
// the legacy typeless shape. (ported from upstream 45ec1d30 + 998bb3d9;
// Switchboard sends client tools typeless instead of dropping them.)
import { describe, it, expect } from "vitest";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

const body = (tools) => ({ model: "deepseek-v4-pro", max_tokens: 1024, messages: [{ role: "user", content: "hello" }], tools });

describe("prepareClaudeRequest — deepseek tool types", () => {
  it("declares the whitelist quirk", () => {
    expect(PROVIDERS.deepseek.quirks.claudeSupportedToolTypes).toEqual(["web_search_20250305", "web_search_20260209"]);
  });

  it("sends client tools without a type discriminator", () => {
    const out = prepareClaudeRequest(body([
      { type: "custom", name: "Bash", input_schema: { type: "object" } },
      { name: "Read", input_schema: { type: "object" } },
      { type: "function", function: { name: "Glob", parameters: { type: "object" } } },
    ]), "deepseek");
    expect(out.tools.map(t => t.name)).toEqual(["Bash", "Read", "Glob"]);
    for (const t of out.tools) expect(t.type).toBeUndefined();
  });

  it("keeps whitelisted web_search built-ins and drops other built-ins", () => {
    const out = prepareClaudeRequest(body([
      { type: "web_search_20250305", name: "web_search" },
      { type: "web_search_20260209", name: "web_search2" },
      { type: "computer_20250124", name: "computer" },
    ]), "deepseek");
    expect(out.tools.map(t => t.type)).toEqual(["web_search_20250305", "web_search_20260209"]);
  });

  it("other non-Claude providers still default type to custom (MiniMax 2013)", () => {
    const out = prepareClaudeRequest(body([{ name: "Read", input_schema: { type: "object" } }]), "minimax");
    expect(out.tools[0].type).toBe("custom");
  });
});
