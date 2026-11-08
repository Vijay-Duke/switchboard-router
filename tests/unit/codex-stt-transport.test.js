import { it, expect, vi, afterEach } from "vitest";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

// Real ffmpeg conversion tests skip when the binary is absent (e.g. bare CI
// runners); the transport tests below mock conversion instead, so they run
// everywhere.
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const holders = vi.hoisted(() => ({ realConvertAudio: null }));
vi.mock("../../open-sse/handlers/codexSttAudio.js", async (importOriginal) => {
  const actual = await importOriginal();
  holders.realConvertAudio = actual.convertAudio;
  return { ...actual, convertAudio: vi.fn() };
});

import { transcribeCodex } from "../../open-sse/handlers/codexStt.js";
import { convertAudio, readBounded, MAX_AUDIO_BYTES } from "../../open-sse/handlers/codexSttAudio.js";

function wav(seconds = 0.02) {
  const pcm = Buffer.alloc(Math.floor(48000 * seconds) * 4);
  const b = Buffer.alloc(44 + pcm.length);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28); b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(pcm.length, 40);
  return b;
}
// Post-conversion shape (mono 24 kHz PCM16) — what convertAudio really returns.
function wav24() {
  const pcm = Buffer.alloc(480);
  const b = Buffer.alloc(44 + pcm.length);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(pcm.length, 40);
  return b;
}
function form(extra = {}) {
  const f = new FormData();
  f.set("model", "cx/transcribe");
  f.set("file", new File([wav()], "input.wav", { type: "audio/wav" }));
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}
const credentials = {
  authType: "oauth",
  accessToken: "test-token",
  refreshToken: "test-refresh",
  providerSpecificData: { workspaceId: "test-account", baseUrl: "https://untrusted.invalid" },
};

afterEach(() => {
  vi.clearAllMocks();
});

it("sends only the converted file and projects upstream metadata out of the response through a local relay", async () => {
  convertAudio.mockResolvedValue(new Blob([wav24()], { type: "audio/wav" }));
  let observed;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    observed = { headers: req.headers, body: Buffer.concat(chunks) };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: "hello", account: "private", segments: [{ start: 0 }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const relay = { vercelRelayUrl: `http://127.0.0.1:${server.address().port}` };
    const result = await transcribeCodex({ formData: form(), credentials, proxyOptions: relay });
    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({ text: "hello" });

    const text = await transcribeCodex({ formData: form({ response_format: "text" }), credentials, proxyOptions: relay });
    expect(await text.response.text()).toBe("hello");
    expect(text.response.headers.get("content-type")).toContain("text/plain");

    // Fixed endpoint — the connection's untrusted baseUrl override is ignored.
    expect(observed.headers["x-relay-target"]).toBe("https://chatgpt.com");
    expect(observed.headers["x-relay-path"]).toBe("/backend-api/transcribe");
    expect(observed.headers.authorization).toBe("Bearer test-token");
    expect(observed.headers["chatgpt-account-id"]).toBe("test-account");
    // Identity layer applies the codex CLI profile even on the relay hop.
    expect(observed.headers["user-agent"]).toMatch(/^codex_cli_rs\//);
    expect(observed.headers.originator).toBe("codex_cli_rs");

    // File-only multipart: exactly one part, no model/options fields.
    const body = observed.body.toString("latin1");
    expect(body.match(/Content-Disposition/g)).toHaveLength(1);
    expect(body).toContain('name="file"');
    expect(body).not.toContain('name="model"');
    const start = observed.body.indexOf(Buffer.from("RIFF"));
    expect(observed.body.readUInt32LE(start + 24)).toBe(24000);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

it("caps two in-flight transcriptions per process", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  convertAudio.mockImplementation(() => gate.then(() => Promise.reject(Object.assign(new Error("stop"), { status: 400 }))));
  const first = transcribeCodex({ formData: form(), credentials });
  const second = transcribeCodex({ formData: form(), credentials });
  await vi.waitFor(() => expect(convertAudio).toHaveBeenCalledTimes(2));
  const third = await transcribeCodex({ formData: form(), credentials });
  expect(third.status).toBe(503);
  expect(third.error).toContain("capacity");
  release();
  expect((await first).status).toBe(400);
  expect((await second).status).toBe(400);
});

it("rejects unsupported fields/formats and oversized uploads before transport", async () => {
  for (const extra of [{ prompt: "context" }, { language: "en" }, { response_format: "srt" }, { "timestamp_granularities[]": "word" }]) {
    expect((await transcribeCodex({ formData: form(extra), credentials })).status).toBe(400);
  }
  const f = form();
  f.set("file", new File([Buffer.alloc(MAX_AUDIO_BYTES + 1)], "large.wav"));
  expect((await transcribeCodex({ formData: f, credentials })).status).toBe(413);
  expect(convertAudio).not.toHaveBeenCalled();
});

it("bounds streaming reads and cancels aborts while waiting for body chunks", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); } });
  await expect(readBounded(stream, 4, controller.signal)).rejects.toMatchObject({ status: 413 });
  const hanging = new ReadableStream();
  const pending = readBounded(hanging, 10, controller.signal);
  controller.abort();
  await expect(pending).rejects.toBeDefined();
});

it.skipIf(!HAS_FFMPEG)("converts real stereo 48k WAV to mono 24k PCM16 and removes temporary files", async () => {
  convertAudio.mockImplementation(holders.realConvertAudio);
  const before = (await readdir(tmpdir())).filter((s) => s.startsWith("switchboard-codex-stt-"));
  const result = Buffer.from(await (await convertAudio(new File([wav()], "in.wav"), new AbortController().signal)).arrayBuffer());
  expect(result.toString("ascii", 0, 4)).toBe("RIFF");
  expect(result.readUInt16LE(22)).toBe(1);       // mono
  expect(result.readUInt32LE(24)).toBe(24000);   // 24 kHz
  expect(result.readUInt16LE(34)).toBe(16);      // PCM16
  expect((await readdir(tmpdir())).filter((s) => s.startsWith("switchboard-codex-stt-"))).toEqual(before);
});

it.skipIf(!HAS_FFMPEG)("rejects malformed and overlong audio and cleans up", async () => {
  convertAudio.mockImplementation(holders.realConvertAudio);
  const before = (await readdir(tmpdir())).filter((s) => s.startsWith("switchboard-codex-stt-"));
  await expect(convertAudio(new File(["invalid"], "in.wav"), new AbortController().signal)).rejects.toMatchObject({ status: 400 });
  await expect(convertAudio(new File([wav(121)], "in.wav"), new AbortController().signal)).rejects.toMatchObject({ status: 400 });
  expect((await readdir(tmpdir())).filter((s) => s.startsWith("switchboard-codex-stt-"))).toEqual(before);
});

it.skipIf(HAS_FFMPEG)("reports a missing ffmpeg binary as a service error, not a crash", async () => {
  convertAudio.mockImplementation(holders.realConvertAudio);
  const result = await transcribeCodex({ formData: form(), credentials });
  expect(result.status).toBe(503);
  expect(result.error).toContain("ffmpeg");
});
