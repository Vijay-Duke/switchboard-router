import { describe, expect, it } from "vitest";
import { summarizeClaudeToolHistory } from "../../open-sse/utils/toolHistoryDiagnostics.js";
const use = id => ({ type: "tool_use", id, name: "SECRET_TOOL_NAME", input: { password: "SECRET_PASSWORD" } });
const result = id => ({ type: "tool_result", tool_use_id: id, content: "SECRET_TOOL_OUTPUT" });
describe("private structural tool-history diagnostics", () => {
  it("distinguishes deleted, moved and orphaned results without logging contents or IDs", () => {
    const body = { messages: [
      { role: "assistant", content: [use("SECRET_CALL_A"), use("SECRET_CALL_B")] },
      { role: "user", content: [{ type: "text", text: "SECRET_PROMPT" }] },
      { role: "assistant", content: [{ type: "text", text: "continue" }] },
      { role: "user", content: [result("SECRET_CALL_A"), result("SECRET_ORPHAN")] },
    ] };
    const summary = summarizeClaudeToolHistory(body);
    expect(summary).toMatchObject({ toolCalls: 2, toolResults: 2, missingResults: 2, misplacedResults: 1, orphanResults: 1 });
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });
  it("accepts parallel calls and adjacent same-role turns that Anthropic merges", () => {
    const summary = summarizeClaudeToolHistory({ messages: [
      { role: "assistant", content: [use("a")] },
      { role: "assistant", content: [use("b")] },
      { role: "user", content: [result("a")] },
      { role: "user", content: [result("b")] },
    ] });
    expect(summary).toMatchObject({ missingResults: 0, orphanResults: 0, invalidTurnCount: 0 });
  });
  it("bounds the diagnostic size for pathological history", () => {
    const messages = Array.from({ length: 500 }, (_, i) => [{ role: "assistant", content: [use(String(i))] }, { role: "user", content: [] }]).flat();
    const summary = summarizeClaudeToolHistory({ messages });
    expect(summary.invalidTurnCount).toBe(500);
    expect(summary.invalidTurns).toHaveLength(10);
    expect(JSON.stringify(summary).length).toBeLessThan(2000);
  });
});
