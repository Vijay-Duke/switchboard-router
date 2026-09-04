import { describe, it, expect } from "vitest";

import { GeminiCLIExecutor } from "../../open-sse/executors/gemini-cli.js";
import { GEMINI_CLI_VERSION, GEMINI_CLI_API_CLIENT } from "../../open-sse/config/appConstants.js";

describe("gemini-cli identity headers (E1)", () => {
  it("exposes a defined numeric client version (never undefined)", () => {
    expect(GEMINI_CLI_VERSION).toBeDefined();
    expect(String(GEMINI_CLI_VERSION)).toMatch(/\d/);
    expect(String(GEMINI_CLI_VERSION)).not.toContain("undefined");
  });

  it("exposes a defined X-Goog-Api-Client value", () => {
    expect(GEMINI_CLI_API_CLIENT).toBeDefined();
    expect(String(GEMINI_CLI_API_CLIENT).length).toBeGreaterThan(0);
    expect(String(GEMINI_CLI_API_CLIENT)).not.toContain("undefined");
  });

  it("buildHeaders emits a well-formed UA and api-client header", () => {
    const ex = new GeminiCLIExecutor();
    const headers = ex.buildHeaders({ accessToken: "test-token" });
    expect(headers["User-Agent"]).toMatch(/GeminiCLI\/\d/);
    expect(headers["User-Agent"]).not.toContain("undefined");
    expect(headers["X-Goog-Api-Client"]).toBeDefined();
    expect(String(headers["X-Goog-Api-Client"])).not.toContain("undefined");
  });
});
