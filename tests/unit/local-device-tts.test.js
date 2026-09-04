// H47 — local-device TTS branches per platform (macOS `say`, Windows SAPI,
// 501 elsewhere) and names the missing binary on ENOENT.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal()), execFile }));
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => "/tmp/tts-test"),
  readFile: vi.fn(async () => Buffer.from("mp3-bytes")),
  rm: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}));

import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";

const realPlatform = process.platform;
const setPlatform = (value) => Object.defineProperty(process, "platform", { value, configurable: true });
const run = () => handleTtsCore({ provider: "local-device", model: "Alex", input: "hello", credentials: null, responseFormat: "json" });
const bins = () => execFile.mock.calls.map((c) => c[0]);

beforeEach(() => {
  execFile.mockReset().mockImplementation((...args) => args.at(-1)(null, "", ""));
});
afterEach(() => setPlatform(realPlatform));

describe("local-device TTS (H47)", () => {
  it("linux → 501 with a clear message, nothing executed", async () => {
    setPlatform("linux");
    const result = await run();
    expect(result).toMatchObject({ success: false, status: 501 });
    expect(result.error).toMatch(/not supported on linux/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("darwin → say then ffmpeg", async () => {
    setPlatform("darwin");
    const result = await run();
    expect(result.success).toBe(true);
    expect(bins()).toEqual(["say", "ffmpeg"]);
    expect(execFile.mock.calls[0][1]).toEqual(expect.arrayContaining(["-v", "Alex", "hello"]));
  });

  it("win32 → PowerShell System.Speech then ffmpeg", async () => {
    setPlatform("win32");
    const result = await run();
    expect(result.success).toBe(true);
    expect(bins()).toEqual(["powershell.exe", "ffmpeg"]);
    const script = execFile.mock.calls[0][1].at(-1);
    expect(script).toContain("System.Speech");
    expect(script).toContain("SelectVoice('Alex')");
  });

  it("missing binary is named in the error", async () => {
    setPlatform("darwin");
    execFile.mockImplementationOnce((...args) => args.at(-1)(Object.assign(new Error("spawn say ENOENT"), { code: "ENOENT" })));
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires 'say'/);
  });
});
