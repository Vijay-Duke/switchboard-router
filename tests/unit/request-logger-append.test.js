import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const originalEnabled = process.env.ENABLE_REQUEST_LOGS;
let tempDir;
let createRequestLogger;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-request-log-append-"));
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

describe("request logger chunk appends (P11)", () => {
  it("opens each chunk file once, never uses appendFileSync, and preserves chunk order", async () => {
    const openSpy = vi.spyOn(fs, "createWriteStream");
    const appendSpy = vi.spyOn(fs, "appendFileSync");
    try {
      const logger = await createRequestLogger("openai", "openai", "gpt-5");
      openSpy.mockClear();
      appendSpy.mockClear();

      const chunks = Array.from({ length: 100 }, (_, i) => `data: {"i":${i}}\n\n`);
      for (const chunk of chunks) logger.appendProviderChunk(chunk);

      // Positive control: the new path opened the file once; nothing went through appendFileSync.
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(appendSpy).not.toHaveBeenCalled();

      // close() resolves once queued writes have drained; order must survive.
      await logger.close();
      const filePath = path.join(logger.sessionPath, "5_res_provider.txt");
      expect(fs.readFileSync(filePath, "utf8")).toBe(chunks.join(""));
    } finally {
      openSpy.mockRestore();
      appendSpy.mockRestore();
    }
  });

  it("opens one stream per chunk file and close() stops further writes", async () => {
    const openSpy = vi.spyOn(fs, "createWriteStream");
    try {
      const logger = await createRequestLogger("openai", "openai", "gpt-5");
      logger.appendProviderChunk("p");
      logger.appendOpenAIChunk("o");
      logger.appendConvertedChunk("c");
      logger.appendProviderChunk("p2");
      expect(openSpy).toHaveBeenCalledTimes(3);
      await logger.close();
      expect(fs.readFileSync(path.join(logger.sessionPath, "5_res_provider.txt"), "utf8")).toBe("pp2");
      expect(fs.readFileSync(path.join(logger.sessionPath, "6_res_openai.txt"), "utf8")).toBe("o");
      expect(fs.readFileSync(path.join(logger.sessionPath, "7_res_client.txt"), "utf8")).toBe("c");

      // Appends after close are dropped, never throw; close() is idempotent.
      logger.appendProviderChunk("late");
      await logger.close();
      expect(openSpy).toHaveBeenCalledTimes(3);
      expect(fs.readFileSync(path.join(logger.sessionPath, "5_res_provider.txt"), "utf8")).toBe("pp2");
    } finally {
      openSpy.mockRestore();
    }
  });
});
