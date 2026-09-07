/**
 * OpenCode free-tier executor: zen free rejects requests without a stable
 * session header (400 MissingSessionID — "free tier can only be used in
 * OpenCode"). The executor must always send x-opencode-session.
 * See open-sse/executors/default.js for the Go-tier twin of this contract.
 */

import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

describe("OpenCodeExecutor session header", () => {
  it("sends x-opencode-session on every request", () => {
    const ex = new OpenCodeExecutor();
    const headers = ex.buildHeaders({ rawHeaders: {}, connectionId: "conn-1" }, true);
    expect(typeof headers["x-opencode-session"]).toBe("string");
    expect(headers["x-opencode-session"].length).toBeGreaterThan(0);
    expect(headers["Authorization"]).toBe("Bearer public");
    expect(headers["x-opencode-client"]).toBe("desktop");
  });

  it("keeps the session stable per connection (prompt-cache affinity)", () => {
    const ex = new OpenCodeExecutor();
    const a = ex.buildHeaders({ rawHeaders: {}, connectionId: "conn-1" }, true);
    const b = ex.buildHeaders({ rawHeaders: {}, connectionId: "conn-1" }, false);
    expect(b["x-opencode-session"]).toBe(a["x-opencode-session"]);
  });

  it("prefers a client-provided session id from raw headers", () => {
    const ex = new OpenCodeExecutor();
    const headers = ex.buildHeaders(
      { rawHeaders: { "x-session-id": "client-sess" }, connectionId: "conn-1" },
      true
    );
    expect(headers["x-opencode-session"]).toBe("client-sess");
  });
});
