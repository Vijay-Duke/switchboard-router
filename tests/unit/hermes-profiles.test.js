import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { buildHermesYaml, removeHermesYaml } from "../../src/lib/cli/modelCatalog.js";
import { readHermesSettings } from "../../src/lib/cli/hermesConfig.js";
import { listProfiles, resolveHermesHome } from "../../src/app/api/cli-tools/hermes-settings/hermesProfiles.js";

let home;
const options = { baseUrl: "http://localhost:20128/v1", models: ["test/main"], defaultModel: "test/main" };
const post = (body) => new Request("http://localhost/api/cli-tools/hermes-settings", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const putConfig = async (profile, yaml) => {
  const target = resolveHermesHome(profile);
  await fs.mkdir(target.dir, { recursive: true });
  await fs.writeFile(target.configPath, yaml);
  return target;
};
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "switchboard-hermes-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

describe("Hermes profile discovery", () => {
  it("discovers identity-bearing profiles, ignores empty folders and keeps names inert", async () => {
    await putConfig("work", 'model: ""\n');
    await fs.writeFile(path.join(resolveHermesHome("work").dir, "profile.yaml"), 'display_name: "Work: coding"\n');
    await fs.mkdir(path.join(home, ".hermes/profiles/empty"));
    expect((await listProfiles()).map(({ name }) => name)).toEqual(["default", "work"]);
    expect((await listProfiles())[1]).toMatchObject({ displayName: "Work: coding", command: "hermes -p work" });
    for (const name of ["../escape", "a/b", "a\\b", "$(touch nope)", "a\nname"]) expect(() => resolveHermesHome(name)).toThrow();
  });
});

describe("Hermes document editing", () => {
  it("preserves comments, restores foreign model roles, and supports the empty model sentinel", () => {
    const original = '# keep comment\nmodel: ""\nauxiliary:\n  vision:\n    provider: own\n    model: own/vision\ntheme: dark\n';
    const yaml = buildHermesYaml(original, { ...options, delegation: "test/delegate", auxiliary: { vision: "test/vision" }, stt: { enabled: true, model: "test/stt" } });
    const settings = readHermesSettings(yaml);
    expect(settings.defaultModel).toBe("test/main");
    expect(settings.delegation).toMatchObject({ provider: "custom:switchboard", model: "test/delegate" });
    expect(settings.auxiliary.vision.model).toBe("test/vision");
    expect(settings.hasSwitchboardStt).toBe(true);
    expect(yaml).toContain("# keep comment");
    const restored = removeHermesYaml(yaml);
    expect(parseYaml(restored)).toEqual(parseYaml(original));
    expect(restored).toContain("# keep comment");
  });

  it("retains managed roles on endpoint refresh, and clears them only when explicitly requested", () => {
    const yaml = buildHermesYaml("", { ...options, delegation: "test/delegate", auxiliary: { vision: "test/vision" }, stt: { enabled: true, model: "test/stt" } });
    const updated = buildHermesYaml(yaml, { ...options, baseUrl: "https://gateway.example/v1" });
    expect(readHermesSettings(updated).delegation.model).toBe("test/delegate");
    expect(readHermesSettings(updated).stt.base_url).toBe("https://gateway.example/v1");
    const cleared = buildHermesYaml(updated, { ...options, delegation: null, auxiliary: { vision: null }, stt: { enabled: false } });
    expect(readHermesSettings(cleared).delegation).toBeNull();
    expect(readHermesSettings(cleared).auxiliary).toEqual({});
    expect(readHermesSettings(cleared).hasSwitchboardStt).toBe(false);
  });

  it("refuses invalid YAML rather than overwriting it", () => {
    expect(() => buildHermesYaml("model: [broken", options)).toThrow(/Invalid Hermes YAML/);
  });
});

describe("Hermes settings API", () => {
  it("scopes apply/reset to the selected profile and keeps env secrets private", async () => {
    const original = '# work\nmodel: ""\ntheme: dark\n';
    const target = await putConfig("work", original);
    const defaultHome = await putConfig("default", "model:\n  default: untouched\n");
    await fs.writeFile(target.envPath, 'BOT_TOKEN="preserve"\n');
    const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");
    const response = await POST(post({ ...options, profile: "work", apiKey: 'key"$test', delegation: "test/sub", auxiliary: { vision: "test/vision" }, audio: { enabled: true, model: "test/stt" } }));
    expect(response.status).toBe(200);
    expect(await fs.readFile(defaultHome.configPath, "utf8")).toContain("untouched");
    const env = await fs.readFile(target.envPath, "utf8");
    expect(env).toContain('BOT_TOKEN="preserve"');
    expect(env).toContain('SWITCHBOARD_API_KEY="key\\"$test"');
    if (process.platform !== "win32") expect((await fs.stat(target.envPath)).mode & 0o777).toBe(0o600);
    const data = await (await GET(new Request("http://localhost/api/cli-tools/hermes-settings?profile=work"))).json();
    expect(data.profile.name).toBe("work");
    expect(data.settings.stt.api_key).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('key"$test');
    const reset = await DELETE(post({ profile: "work" }));
    expect(reset.status).toBe(200);
    expect(parseYaml(await fs.readFile(target.configPath, "utf8"))).toEqual(parseYaml(original));
    expect(await fs.readFile(target.envPath, "utf8")).toBe('BOT_TOKEN="preserve"\n');
  });

  it("redacts a foreign transcription credential in GET", async () => {
    await putConfig("default", 'stt:\n  provider: openai\n  openai:\n    model: whisper-1\n    api_key: foreign-secret\n');
    const { GET } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");
    const response = await GET();
    expect(JSON.stringify(await response.json())).not.toContain("foreign-secret");
  });

  it("bulk refresh preserves models and skips foreign profiles", async () => {
    const a = await putConfig("default", buildHermesYaml("", options));
    const b = await putConfig("work", buildHermesYaml("", { ...options, models: ["test/work"] }));
    const c = await putConfig("foreign", 'model:\n  default: own/model\n  provider: own\n');
    const foreign = await fs.readFile(c.configPath, "utf8");
    const { POST } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");
    const response = await POST(post({ ...options, baseUrl: "https://new.example/v1", applyToAll: true, apiKey: "new-key" }));
    const data = await response.json();
    expect(data.updated).toBe(2);
    expect(data.results.find(({ profile }) => profile === "foreign").status).toBe("skipped");
    expect(readHermesSettings(await fs.readFile(a.configPath, "utf8")).defaultModel).toBe("test/main");
    const work = readHermesSettings(await fs.readFile(b.configPath, "utf8"));
    expect(work.defaultModel).toBe("test/work");
    expect(work.model.base_url).toBe("https://new.example/v1");
    expect(await fs.readFile(c.configPath, "utf8")).toBe(foreign);
  });

  it("rejects missing profiles, traversal, and invalid role values before writing", async () => {
    const { POST } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");
    expect((await POST(post({ ...options, profile: "missing" }))).status).toBe(404);
    expect((await POST(post({ ...options, profile: "../escape" }))).status).toBe(400);
    expect((await POST(post({ ...options, auxiliary: { vision: {} } }))).status).toBe(400);
    expect((await POST(post({ ...options, delegation: {} }))).status).toBe(400);
  });
});
