import { describe, it, expect, afterEach, vi } from "vitest";
import {
  startCodexProxy,
  stopCodexProxy,
  registerCodexSession,
  getCodexSessionStatus,
  clearCodexSession,
} from "../../src/lib/oauth/utils/server.js";
import { CODEX_CONFIG } from "../../src/lib/oauth/constants/oauth.js";

const PORT = CODEX_CONFIG.fixedPort;
const callback = (state) =>
  fetch(`http://127.0.0.1:${PORT}/callback?state=${state}&error=access_denied`);

/**
 * Regression: the callback handler called stopCodexProxy() in a `finally`, so
 * the first browser callback tore down the fixed-port server. Any other OAuth
 * flow still waiting on that port then got ECONNREFUSED.
 *
 * Uses `error=access_denied` so the handler fails fast without hitting the
 * token exchange or the DB.
 */
describe("codex OAuth proxy with concurrent sessions", () => {
  afterEach(() => {
    stopCodexProxy();
    clearCodexSession("state-a");
    clearCodexSession("state-b");
  });

  it("keeps serving a second pending session after the first completes", async () => {
    registerCodexSession({ state: "state-a", codeVerifier: "v", redirectUri: "http://x/cb" });
    registerCodexSession({ state: "state-b", codeVerifier: "v", redirectUri: "http://x/cb" });
    await startCodexProxy(3000);

    const first = await callback("state-a");
    expect(first.status).toBe(200);
    expect(getCodexSessionStatus("state-a").status).toBe("error");

    // Before the fix this threw ECONNREFUSED — the proxy was already closed.
    const second = await callback("state-b");
    expect(second.status).toBe(200);
    expect(getCodexSessionStatus("state-b").status).toBe("error");
  });

  it("sweeps abandoned sessions instead of leaking them", () => {
    vi.useFakeTimers();
    try {
      registerCodexSession({ state: "state-a", codeVerifier: "v", redirectUri: "http://x/cb" });
      expect(getCodexSessionStatus("state-a")).not.toBeNull();

      // Popup closed, never polled. Six minutes later a new flow starts.
      vi.advanceTimersByTime(6 * 60 * 1000);
      registerCodexSession({ state: "state-b", codeVerifier: "v", redirectUri: "http://x/cb" });

      expect(getCodexSessionStatus("state-a")).toBeNull();
      expect(getCodexSessionStatus("state-b")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
