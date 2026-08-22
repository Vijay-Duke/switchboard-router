import { afterEach, expect, it, vi } from "vitest";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("never writes the resolved Codex session identifier to debug console output", async () => {
  const rawSession = "raw-codex-session-do-not-log-9472";
  vi.spyOn(BaseExecutor.prototype, "execute").mockResolvedValue({
    success: true,
    response: new Response("ok"),
  });
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const executor = new CodexExecutor();
  executor._currentSessionId = rawSession;

  await executor.execute({ body: { input: [] } });

  expect(consoleLog.mock.calls.flat().join(" ")).not.toContain(rawSession);
});
