// @ts-check
// Codex profiles live in ~/.codex/<name>.config.toml (layered by `codex -p`).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const homes = vi.hoisted(() => ({ dir: "/tmp/codex-profiles-home" }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => homes.dir;
  return { ...actual, default: { ...actual.default, homedir }, homedir };
});

import { GET, POST, DELETE } from "../../src/app/api/cli-tools/codex-profiles/route.js";

const tmps = [];
beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-codexprof-"));
  tmps.push(dir);
  homes.dir = dir;
});
afterEach(async () => {
  while (tmps.length) await fs.rm(tmps.pop(), { recursive: true, force: true }).catch(() => {});
});

const req = (method, body) => new Request("http://l/api/cli-tools/codex-profiles", {
  method,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("codex-profiles route", () => {
  it("creates, lists and deletes a profile pointing at the switchboard provider", async () => {
    const res = await POST(req("POST", { name: "Claude", model: "cc/claude-sonnet-5" }));
    expect(res.status).toBe(200);
    const file = path.join(homes.dir, ".codex", "claude.config.toml");
    const content = await fs.readFile(file, "utf-8");
    expect(content).toContain('model = "cc/claude-sonnet-5"');
    expect(content).toContain('model_provider = "switchboard"');

    // The base config.toml is never listed as a profile.
    await fs.writeFile(path.join(homes.dir, ".codex", "config.toml"), 'model = "x"\n');
    const list = await (await GET()).json();
    expect(list.profiles).toEqual([{ name: "claude", model: "cc/claude-sonnet-5", command: "codex -p claude" }]);

    expect((await DELETE(req("DELETE", { name: "claude" }))).status).toBe(200);
    await expect(fs.access(file)).rejects.toThrow();
    expect((await DELETE(req("DELETE", { name: "claude" }))).status).toBe(404);
  });

  it("rejects traversal names, injected models and bad JSON", async () => {
    expect((await POST(req("POST", { name: "../x", model: "a/b" }))).status).toBe(400);
    expect((await POST(req("POST", { name: "config", model: "a/b" }))).status).toBe(400);
    expect((await POST(req("POST", { name: "ok", model: 'a"\nx = "y' }))).status).toBe(400);
    expect((await POST(req("POST", "{not json"))).status).toBe(400);
    expect((await DELETE(req("DELETE", { name: "../config" }))).status).toBe(400);
  });

  it("returns an empty list when ~/.codex does not exist", async () => {
    expect(await (await GET()).json()).toEqual({ profiles: [] });
  });
});
