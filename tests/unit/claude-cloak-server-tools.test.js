import { describe, it, expect } from "vitest";

import { cloakClaudeTools } from "../../open-sse/utils/claudeCloaking.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";

describe("claude cloaking with server tools (E12)", () => {
  it("leaves server-typed history blocks unsuffixed while renaming client tools", () => {
    const body = {
      tools: [
        { name: "web_search", type: "server", description: "s" },
        { name: "mytool", type: "custom", description: "c", input_schema: { type: "object" } },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "web_search", input: {} },
            { type: "tool_use", id: "b", name: "mytool", input: {} },
          ],
        },
      ],
    };
    const { body: cloaked, toolNameMap } = cloakClaudeTools(body);
    const toolNames = cloaked.tools.map((t) => t.name);
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain(`mytool${CLAUDE_TOOL_SUFFIX}`);
    expect(toolNames).not.toContain(`web_search${CLAUDE_TOOL_SUFFIX}`);

    const names = cloaked.messages[0].content.map((b) => b.name);
    expect(names).toContain("web_search");
    expect(names).toContain(`mytool${CLAUDE_TOOL_SUFFIX}`);

    expect(toolNameMap.get(`mytool${CLAUDE_TOOL_SUFFIX}`)).toBe("mytool");
  });
});
