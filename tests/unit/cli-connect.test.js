import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { run, __test__: { parseArgs } } = require("../../cli/src/cli/commands/connect.js");
const { loadSession, saveSession, normalizeServerUrl } = require("../../cli/src/cli/commands/remoteConnection.js");
const { __test__: { inspect, findTool } } = require("../../cli/src/cli/commands/show.js");
const secret = "sk_new_one_time_secret_abcdef";
let dir, output, fetchImpl, writer;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-connect-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("SWITCHBOARD_CONNECT_KEY", "");
  output = [];
  vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => output.push(args.join(" ")));
  writer = { applyCliToolSettings: vi.fn(async () => ({ success: true })), resetCliToolSettings: vi.fn(async () => ({ success: true })), saveCodexProfile: vi.fn(async () => ({ success: true })) };
  fetchImpl = vi.fn(async (url, init) => {
    if (url.endsWith("/api/auth/login")) return Response.json({ ok: true }, { headers: { "Set-Cookie": "switchboard_session=session-secret; HttpOnly; Path=/" } });
    if (url.endsWith("/api/keys") && init.method === "POST") return Response.json({ id: "new-id", key: secret });
    if (url.endsWith("/api/v1/models")) return Response.json({ data: [{ id: "test/main", kind: "llm" }] });
    if (url.endsWith("/api/keys/new-id") && init.method === "DELETE") return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${init.method} ${url}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
const args = ["https://gateway.example", "--api-key", "dashboard-secret", "--tools", "claude,codex", "--model", "test/main"];
describe("secure CLI connections", () => {
  it("signs in, mints a new key and applies local files without listing keys or sharing machine credentials", async () => {
    expect(await run(args, { fetch: fetchImpl, writer })).toBe(0);
    expect(fetchImpl.mock.calls.map(([url, init]) => `${init.method} ${new URL(url).pathname}`)).toEqual(["POST /api/auth/login", "POST /api/keys", "GET /api/v1/models"]);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ apiKey: "dashboard-secret" });
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.redirect).toBe("manual");
      expect(Object.keys(init.headers).some(key => /cli.*token/i.test(key))).toBe(false);
    }
    expect(fetchImpl.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${secret}`);
    expect(writer.applyCliToolSettings).toHaveBeenCalledWith("codex", expect.objectContaining({ baseUrl: "https://gateway.example", apiKey: secret, model: "test/main" }));
    expect(output.join("\n")).not.toContain(secret);
    expect(output.join("\n")).not.toContain("dashboard-secret");
    expect(fs.existsSync(path.join(dir, "connect-session.json"))).toBe(false);
  });
  it("stores only an origin-bound session with owner-only permissions when requested", async () => {
    expect(await run([...args, "--save"], { fetch: fetchImpl, writer })).toBe(0);
    const file = path.join(dir, "connect-session.json");
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/dashboard-secret|sk_new/);
    expect(loadSession("https://gateway.example")).toBe("switchboard_session=session-secret");
    expect(loadSession("https://other.example")).toBe(null);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it("reuses saved sessions but still creates a new client key", async () => {
    saveSession("https://gateway.example", "switchboard_session=saved");
    expect(await run(["https://gateway.example", "--tools", "claude"], { fetch: fetchImpl, writer })).toBe(0);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://gateway.example/api/keys");
    expect(fetchImpl.mock.calls[0][1].headers.Cookie).toBe("switchboard_session=saved");
  });
  it("revokes an unused key when configuration fails, even when a writer throws", async () => {
    writer.applyCliToolSettings.mockRejectedValue(new Error("writer failure"));
    expect(await run(args, { fetch: fetchImpl, writer })).toBe(1);
    expect(fetchImpl.mock.calls.at(-1)[1].method).toBe("DELETE");
  });
  it("keeps a key used by a successful tool when another tool fails", async () => {
    writer.applyCliToolSettings.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error("failure"));
    expect(await run(args, { fetch: fetchImpl, writer })).toBe(1);
    expect(fetchImpl.mock.calls.some(([, init]) => init.method === "DELETE")).toBe(false);
  });
  it("reset is local and requires no authentication", async () => {
    expect(await run(["--reset", "--tools", "codex"], { fetch: fetchImpl, writer })).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writer.resetCliToolSettings).toHaveBeenCalledWith("codex");
  });
  it("rejects unsafe URLs and invalid profiles before minting", async () => {
    expect(() => normalizeServerUrl("https://user:secret@gateway.example")).toThrow();
    expect(() => parseArgs(["--host", "remote.example"])).toThrow();
    expect(await run([...args, "--codex-profile", "../escape=x"], { fetch: fetchImpl, writer })).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("does not forward sessions across redirects or print server error payloads", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ error: "secret-server-error" }, { status: 302, headers: { Location: "https://elsewhere.example" } }));
    expect(await run(args, { fetch: fetchImpl, writer })).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(output.join("\n")).not.toContain("secret-server-error");
  });
  it("prints a newly minted key only under explicit --print-env", async () => {
    expect(await run([...args, "--print-env"], { fetch: fetchImpl, writer })).toBe(0);
    expect(output.filter(line => line.includes(secret))).toEqual([`export OPENAI_API_KEY='${secret}'`]);
  });
  it("show strips credentials, URL query secrets, and terminal controls", () => {
    const result = inspect(findTool("claude"), { settings: { env: { ANTHROPIC_BASE_URL: "https://user:password@gateway.example/v1?key=secret", ANTHROPIC_AUTH_TOKEN: secret, ANTHROPIC_MODEL: "test/\x1bmodel" } } });
    expect(result.baseUrl).toBe("https://gateway.example/v1");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.models.main).toBe("test/model");
  });
});
