import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { buildConfigWriters } = require("../../cli/scripts/build-config-writers.js");
const root = path.resolve(import.meta.dirname, "../..");
let dir, bundle;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-writers-"));
  bundle = path.join(dir, "writers.cjs");
  await buildConfigWriters(bundle);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
describe("standalone tool configuration", () => {
  it("applies and inspects real tool configs without a server or SQLite", () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(home);
    const result = execFileSync(process.execPath, ["-e", `
      const os = require('node:os'); os.homedir = () => ${JSON.stringify(home)};
      const fs = require('node:fs');
      fs.mkdirSync(${JSON.stringify(home)} + '/.claude', { recursive:true });
      const original = '{"theme":"dark","env":{"ANTHROPIC_DEFAULT_OPUS_MODEL":"original/model"}}';
      fs.writeFileSync(${JSON.stringify(home)} + '/.claude/settings.json', original);
      const { invoke } = require(${JSON.stringify(bundle)});
      const { TOOLS } = require(${JSON.stringify(path.join(root, "cli/src/cli/commands/connectTools.js"))});
      const { __test__: { inspect } } = require(${JSON.stringify(path.join(root, "cli/src/cli/commands/show.js"))});
      (async () => {
        const out = [];
        for (const tool of TOOLS.filter(t => t.id !== 'cowork')) {
          const apply = await invoke(tool.id, 'POST', tool.buildBody({baseUrl:'https://gateway.example',apiKey:'sk_test_new_secret_123456789',model:'test/main'}));
          const read = await invoke(tool.id, 'GET');
          out.push({id:tool.id,apply,record:inspect(tool,read.data)});
        }
        const profile = await invoke('codex-profiles', 'POST', {name:'work',model:'test/profile'});
        if (!profile.success) throw new Error('Cannot save Codex profile');
        const profiles = await invoke('codex-profiles', 'GET');
        if (profiles.data.profiles[0]?.model !== 'test/profile') throw new Error('Codex profile roundtrip failed');
        const reset = await invoke('claude', 'DELETE');
        if (!reset.success || fs.readFileSync(${JSON.stringify(home)} + '/.claude/settings.json', 'utf8').includes('gateway.example')) throw new Error('Claude reset failed');
        if (!fs.readFileSync(${JSON.stringify(home)} + '/.claude/settings.json', 'utf8').includes('original/model')) throw new Error('Claude reset lost prior tiers');
        console.log('RESULT:' + JSON.stringify(out));
      })().catch(e => { console.error(e); process.exit(1); });
    `], { cwd: home, env: { ...process.env, DATA_DIR: path.join(home, "data"), APPDATA: home, XDG_CONFIG_HOME: path.join(home, ".config") }, encoding: "utf8", timeout: 30000 });
    const records = JSON.parse(result.split("RESULT:")[1]);
    for (const { id, apply, record } of records) {
      expect(apply.success, `${id}: ${JSON.stringify(apply)}`).toBe(true);
      expect.soft(record.configured, `${id}: ${JSON.stringify(record)}`).toBe(true);
      expect.soft(record.baseUrl, id).toMatch(/^https:\/\/gateway\.example/);
      if (id !== "claude") expect(JSON.stringify(record.models), id).toContain("test/main");
      expect(JSON.stringify(record), id).not.toContain("sk_test_new_secret_123456789");
    }
    expect(fs.existsSync(path.join(home, "data/db/data.sqlite"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".pi/agent/models.yml"), "utf8")).toContain("test/main");
    if (process.platform !== "win32") expect(fs.statSync(path.join(home, ".claude/settings.json")).mode & 0o777).toBe(0o600);
  }, 40000);
});
