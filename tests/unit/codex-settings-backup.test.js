// @ts-check
// T121: Apply must snapshot pre-existing root model/subagent values and
// Disconnect must restore them — a pre-existing subagent setup survives the
// Apply → Disconnect round-trip. Also covers the atomic-write cutover.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const homes = vi.hoisted(() => ({ dir: "/tmp/r2-codex-home" }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => homes.dir;
  return { ...actual, default: { ...actual.default, homedir }, homedir };
});

// "which codex" succeeds so the installed-check passes without exec.
vi.mock("child_process", () => {
  const exec = (cmd, opts, cb) => {
    const done = typeof opts === "function" ? opts : cb;
    done(null, { stdout: "", stderr: "" });
    return { kill() {} };
  };
  return { default: { exec }, exec };
});

import { GET, POST, DELETE } from "../../src/app/api/cli-tools/codex-settings/route.js";

const tmps = [];

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-r2codex-"));
  tmps.push(dir);
  homes.dir = dir;
});

afterEach(async () => {
  while (tmps.length) {
    await fs.rm(tmps.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

const post = () => POST(new Request("http://l/api/cli-tools/codex-settings", {
  method: "POST",
  body: JSON.stringify({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk_switchboard", model: "sw/model-a" }),
}));

describe("codex-settings Apply → Disconnect round-trip (T121)", () => {
  it("restores pre-existing model, model_provider and agents.subagent", async () => {
    const cfgDir = path.join(homes.dir, ".codex");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(path.join(cfgDir, "config.toml"), [
      'model = "gpt-5-codex"',
      'model_provider = "openai"',
      "",
      "[agents.subagent]",
      'model = "o4-mini"',
      "limit = 3",
      "",
      "[projects.\"/tmp/demo\"]",
      "trust_level = \"trusted\"",
      "",
    ].join("\n"));

    const apply = await post();
    expect(apply.status).toBe(200);
    const applied = await fs.readFile(path.join(cfgDir, "config.toml"), "utf-8");
    expect(applied).toContain("switchboard");

    const del = await DELETE();
    expect(del.status).toBe(200);
    const restored = await fs.readFile(path.join(cfgDir, "config.toml"), "utf-8");
    const parsed = restored;
    expect(parsed).toContain('model = "gpt-5-codex"');
    expect(parsed).toContain('model_provider = "openai"');
    expect(parsed).toContain('model = "o4-mini"');
    expect(parsed).toContain("limit = 3");
    // Unrelated sections untouched.
    expect(parsed).toContain("[projects.\"/tmp/demo\"]");
    // Switchboard markers gone.
    expect(parsed).not.toContain("[model_providers.switchboard]");
  });

  it("takes a backup on first Apply only, so re-Apply keeps the original snapshot", async () => {
    const cfgDir = path.join(homes.dir, ".codex");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(path.join(cfgDir, "config.toml"), 'model = "original"\n');

    await post();
    await post(); // second Apply must not re-snapshot the switchboard values
    await DELETE();

    const restored = await fs.readFile(path.join(cfgDir, "config.toml"), "utf-8");
    expect(restored).toContain('model = "original"');
    expect(restored).not.toContain("switchboard");
  });

  it("Disconnect consumes the backup so the next Apply snapshots the current state", async () => {
    const cfgDir = path.join(homes.dir, ".codex");
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(path.join(cfgDir, "config.toml"), 'model = "first"\n');
    await post();
    await DELETE();
    await expect(fs.access(path.join(cfgDir, "switchboard-backup.json"))).rejects.toThrow();

    await fs.writeFile(path.join(cfgDir, "config.toml"), 'model = "second"\n');
    await post();
    await DELETE();
    expect(await fs.readFile(path.join(cfgDir, "config.toml"), "utf-8")).toContain('model = "second"');
  });

  it("local Apply without an apiKey defaults to sk_switchboard (T39 route half)", async () => {
    const res = await POST(new Request("http://l/api/cli-tools/codex-settings", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:20128", apiKey: null, model: "sw/model-a" }),
    }));
    expect(res.status).toBe(200);
    const auth = JSON.parse(await fs.readFile(path.join(homes.dir, ".codex", "auth.json"), "utf-8"));
    expect(auth.OPENAI_API_KEY).toBe("sk_switchboard");
  });
});
