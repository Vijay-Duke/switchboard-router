import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const originalEnabled = process.env.ENABLE_REQUEST_LOGS;
let tempDir;
let createRequestLogger;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-request-log-security-"));
  process.chdir(tempDir);
  process.env.ENABLE_REQUEST_LOGS = "true";
  vi.resetModules();
  ({ createRequestLogger } = await import("../../open-sse/utils/requestLogger.js"));
});

afterAll(() => {
  process.chdir(originalCwd);
  if (originalEnabled === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalEnabled;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("enabled request log files", () => {
  it("never writes a full or trailing gateway secret for any carrier", async () => {
    const rawKey = "sk-enabled-log-super-secret-tail";
    const logger = await createRequestLogger("openai", "openai", "gpt-5");
    logger.logClientRawRequest("/v1/chat/completions", { model: "gpt-5" }, {
      authorization: `Bearer ${rawKey}`,
      "x-switchboard-key": rawKey,
      "x-api-key": rawKey,
      "x-goog-api-key": rawKey,
    });
    const bytes = fs.readdirSync(logger.sessionPath)
      .map((name) => fs.readFileSync(path.join(logger.sessionPath, name), "utf8"))
      .join("\n");
    expect(bytes).not.toContain(rawKey);
    expect(bytes).not.toContain(rawKey.slice(-12));
    expect(bytes.match(/\[redacted\]/g)).toHaveLength(4);
  });

  it("redacts every raw affinity identifier from headers and nested request bodies", async () => {
    const rawSession = "raw-affinity-session-do-not-persist-9472";
    const logger = await createRequestLogger("openai", "codex", "gpt-5");
    const body = {
      prompt_cache_key: rawSession,
      session_id: rawSession,
      conversation_id: rawSession,
      metadata: {
        user_id: rawSession,
        sessionId: rawSession,
      },
      request: { sessionId: rawSession },
    };
    const headers = {
      "x-session-id": rawSession,
      "session-id": rawSession,
      "x-client-request-id": rawSession,
    };

    logger.logClientRawRequest("/v1/responses", body, headers);
    logger.logRawRequest(body, headers);
    logger.logOpenAIRequest(body);
    logger.logTargetRequest("https://example.test", headers, body);
    logger.logError(new Error("failed"), body);

    const bytes = fs.readdirSync(logger.sessionPath)
      .map((name) => fs.readFileSync(path.join(logger.sessionPath, name), "utf8"))
      .join("\\n");
    expect(bytes).not.toContain(rawSession);
    expect(bytes).toContain("[redacted]");
  });
});
