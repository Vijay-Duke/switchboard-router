/**
 * OpenCode free-tier executor: the free lane rejects requests without a stable
 * session header (400 MissingSessionID / 403 FreeTierError — "free tier can
 * only be used in OpenCode"). The executor must always send x-opencode-session
 * and its session-id mirrors, in the v2 canonical form.
 * See open-sse/executors/default.js for the Go-tier twin of this contract.
 */

import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OPENCODE_SESSION_RE } from "../../open-sse/utils/opencodeFingerprint.js";

const makeCredentials = (rawHeaders = {}) => ({ rawHeaders, connectionId: "conn-1" });

describe("OpenCodeExecutor session header", () => {
  it("sends x-opencode-session on every request", () => {
    const ex = new OpenCodeExecutor();
    const headers = ex.buildHeaders(makeCredentials(), true);
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    // v2 CLI mirrors: the session rides on every affinity header.
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-session-affinity"]).toBe(headers["x-opencode-session"]);
    expect(headers["x-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["Authorization"]).toBe("Bearer public");
    expect(headers["x-opencode-client"]).toBe("cli");
  });

  it("keeps the session stable per connection (prompt-cache affinity)", () => {
    const ex = new OpenCodeExecutor();
    const a = ex.buildHeaders(makeCredentials(), true);
    const b = ex.buildHeaders(makeCredentials(), false);
    expect(b["x-opencode-session"]).toBe(a["x-opencode-session"]);
  });

  it("preserves a valid client-provided ses_ id and translates an invalid one", () => {
    const ex = new OpenCodeExecutor();
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const kept = ex.buildHeaders(makeCredentials({ "x-session-id": valid }), true);
    expect(kept["x-opencode-session"]).toBe(valid);

    // "client-sess" is not a canonical session: the free gate 400s on it, so
    // the executor swaps in a generated ses_ id instead of forwarding it.
    const translated = ex.buildHeaders(makeCredentials({ "x-session-id": "client-sess" }), true);
    expect(translated["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(translated["x-opencode-session"]).not.toBe("client-sess");
  });
});
