import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const originalEnabled = process.env.ENABLE_REQUEST_LOGS;
let tempDir;
let createRequestLogger;
let maskSensitiveHeaders;
let scrubLoggedUrl;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-request-log-masking-"));
  process.chdir(tempDir);
  process.env.ENABLE_REQUEST_LOGS = "true";
  vi.resetModules();
  ({ createRequestLogger, maskSensitiveHeaders, scrubLoggedUrl } = await import("../../open-sse/utils/requestLogger.js"));
});

afterAll(() => {
  process.chdir(originalCwd);
  if (originalEnabled === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalEnabled;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const GEMINI_KEY = "AIzaSy-gemini-query-secret-0123456789";
const ELEVEN_KEY = "eleven-labs-secret-key-0123456789";
const BFL_KEY = "bfl-secret-key-0123456789";

describe("request log secret scrubbing (H36)", () => {
  it("masks ?key= style query secrets in logged URLs", () => {
    expect(scrubLoggedUrl(`https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${GEMINI_KEY}&alt=sse`))
      .toBe("https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=[redacted]&alt=sse");
    expect(scrubLoggedUrl("https://api.example/v1?api_key=abc&api-key=def")).toBe("https://api.example/v1?api_key=[redacted]&api-key=[redacted]");
    expect(scrubLoggedUrl("https://api.example/v1?monkey=1")).toBe("https://api.example/v1?monkey=1");
  });

  it("fully redacts xi-api-key and x-key headers", () => {
    const masked = maskSensitiveHeaders({ "xi-api-key": ELEVEN_KEY, "x-key": BFL_KEY, accept: "audio/mpeg" });
    expect(masked["xi-api-key"]).toBe("[redacted]");
    expect(masked["x-key"]).toBe("[redacted]");
    expect(masked.accept).toBe("audio/mpeg");
  });

  it("writes neither the URL key nor provider key headers to the target request log on disk", async () => {
    const logger = await createRequestLogger("openai", "gemini", "gemini-2.5-flash");
    logger.logTargetRequest(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      { "xi-api-key": ELEVEN_KEY, "x-key": BFL_KEY, "content-type": "application/json" },
      { contents: [] },
    );
    const target = JSON.parse(fs.readFileSync(path.join(logger.sessionPath, "4_req_target.json"), "utf8"));
    const bytes = JSON.stringify(target);
    expect(bytes).not.toContain(GEMINI_KEY);
    expect(bytes).not.toContain(ELEVEN_KEY);
    expect(bytes).not.toContain(BFL_KEY);
    expect(target.url).toContain("key=[redacted]");
  });
});
