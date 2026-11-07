// Command Code identity headers mirror command-code@1.88.0, and x-session-id is
// the body's conversation-stable threadId. (ported from upstream b1effa03)
import { describe, it, expect } from "vitest";
import { CommandCodeExecutor } from "../../open-sse/executors/commandcode.js";

describe("Command Code request headers", () => {
  it("sends the 1.88.0 static identity headers", () => {
    const h = new CommandCodeExecutor().buildHeaders({ apiKey: "user_x" }, true, null, "m", { threadId: "t-1" });
    expect(h).toMatchObject({
      "User-Agent": "cli",
      "x-command-code-version": "1.88.0",
      "x-cli-environment": "production",
      "x-cli-surface": "cli",
      "x-taste-learning": "false",
      Authorization: "Bearer user_x",
      Accept: "text/event-stream",
    });
  });

  it("reuses the body threadId as x-session-id", () => {
    const ex = new CommandCodeExecutor();
    expect(ex.buildHeaders({ apiKey: "k" }, true, null, "m", { threadId: "thread-abc" })["x-session-id"]).toBe("thread-abc");
    expect(ex.buildHeaders({ apiKey: "k" }, true)["x-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
