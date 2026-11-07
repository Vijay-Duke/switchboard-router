import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { injectReasoningContent } from "../../open-sse/utils/reasoningContentInjector.js";

describe("OpenCode Free transport flags", () => {
  it("declares forceStream so chatCore aggregates the SSE-only free tier for JSON clients", () => {
    expect(PROVIDERS.opencode.forceStream).toBe(true);
  });

  it("injects a reasoning_content placeholder on prior assistant turns", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
    };
    const out = injectReasoningContent({ provider: "opencode", model: "big-pickle", body });
    expect(out.messages[1].reasoning_content).toBe(" ");
    expect(out.messages[0].reasoning_content).toBeUndefined();
  });
});
