// @ts-check
// Round-2 dashboard-tools API route fixes: T117 registry pagination, T118
// probe validation/proxy, T119/T120 opencode tolerant config, T122 cowork
// baseUrl normalization, T123 deepseek reset without backup, T124 gemini
// corrupt settings. All fs goes through a per-test tmp homedir.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "node:url";

const homes = vi.hoisted(() => ({ dir: "/tmp/r2-routes-home", platform: "darwin" }));
const proxyFetchMock = vi.hoisted(() => vi.fn());
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => homes.dir;
  // Platform is switchable per test so the cowork route's darwin/win32/linux
  // config-dir resolution is exercised on every CI runner.
  const platform = () => homes.platform;
  return { ...actual, default: { ...actual.default, homedir, platform }, homedir, platform };
});

// "which <tool>" always finds the tool so installed-checks pass without exec.
vi.mock("child_process", () => {
  const exec = (cmd, opts, cb) => {
    const done = typeof opts === "function" ? opts : cb;
    done(null, { stdout: "", stderr: "" });
    return { kill() {} };
  };
  const spawn = () => ({ on() {}, kill() {}, stdout: { on() {} }, stderr: { on() {} } });
  return { default: { exec, spawn }, exec, spawn };
});
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: proxyFetchMock }));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "test-machine-id"),
}));

import { GET as registryGET } from "../../src/app/api/cli-tools/cowork-mcp-registry/route.js";
import { POST as probePOST } from "../../src/app/api/cli-tools/cowork-mcp-tools/route.js";
import { GET as opencodeGET, POST as opencodePOST } from "../../src/app/api/cli-tools/opencode-settings/route.js";
import { POST as coworkPOST } from "../../src/app/api/cli-tools/cowork-settings/route.js";
import { DELETE as deepseekDELETE } from "../../src/app/api/cli-tools/deepseek-tui-settings/route.js";
import { GET as geminiGET } from "../../src/app/api/cli-tools/gemini-cli-settings/route.js";
import { POST as droidPOST } from "../../src/app/api/cli-tools/droid-settings/route.js";
import { POST as openclawPOST } from "../../src/app/api/cli-tools/openclaw-settings/route.js";

const tmps = [];
async function freshHome() {
  const dir = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".tmp-r2home-"));
  tmps.push(dir);
  homes.dir = dir;
  return dir;
}
const homeFile = async (rel, content) => {
  const p = path.join(homes.dir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return p;
};

beforeEach(() => {
  vi.clearAllMocks();
  delete globalThis.__switchboardCoworkMcpRegistryCache;
});

afterEach(async () => {
  while (tmps.length) {
    await fs.rm(tmps.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

function page(servers, nextCursor) {
  return { ok: true, status: 200, json: async () => ({ servers, metadata: nextCursor ? { nextCursor } : {} }) };
}
const serverItem = (name) => ({
  server: { name, title: name, description: "d", remotes: [{ url: `https://mcp.example.com/${name}`, type: "http" }] },
  _meta: { "com.anthropic.api/mcp-registry": { slug: name, toolNames: [], isAuthless: true } },
});

describe("cowork-mcp-registry GET (T117)", () => {
  it("returns 500 on a mid-pagination failure and does not cache the partial page", async () => {
    proxyFetchMock
      .mockResolvedValueOnce(page([serverItem("a")], "cursor2"))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

    const res = await registryGET(new Request("http://localhost/api/cli-tools/cowork-mcp-registry"));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.servers).toEqual([]);

    // Cache untouched: next successful full fetch is fresh (cached:false), not
    // the partial [a] page.
    proxyFetchMock.mockReset();
    proxyFetchMock.mockResolvedValueOnce(page([serverItem("a"), serverItem("b")], null));
    const res2 = await registryGET(new Request("http://localhost/api/cli-tools/cowork-mcp-registry"));
    const body2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(body2.cached).toBe(false);
    expect(body2.total).toBe(2);
  });
});

describe("cowork-mcp-tools POST (T118)", () => {
  it("rejects non-http(s) probe URLs with 400", async () => {
    const res = await probePOST(new Request("http://localhost/api/cli-tools/cowork-mcp-tools", {
      method: "POST",
      body: JSON.stringify({ url: "ftp://evil.example/x" }),
    }));
    expect(res.status).toBe(400);
    expect(proxyFetchMock).not.toHaveBeenCalled();
  });

  it("probes through proxyAwareFetch so egress matches the registry route", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
      headers: new Headers(),
      json: async () => ({ result: { tools: [{ name: "t1", description: "" }] } }),
    });
    const res = await probePOST(new Request("http://localhost/api/cli-tools/cowork-mcp-tools", {
      method: "POST",
      body: JSON.stringify({ url: "https://mcp.example.com/api" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools.map((t) => t.name)).toEqual(["t1"]);
    expect(proxyFetchMock).toHaveBeenCalled();
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://mcp.example.com/api");
  });
});

describe("opencode-settings (T119, T120)", () => {
  it("POST 200 on a JSONC config (trailing comma) and preserves unrelated keys", async () => {
    await freshHome();
    await homeFile(".config/opencode/opencode.json", '{\n  "theme": "dark",\n}\n');

    const res = await opencodePOST(new Request("http://localhost/api/cli-tools/opencode-settings", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:20128", apiKey: "sk_x", models: ["m1"] }),
    }));
    expect(res.status).toBe(200);

    const saved = JSON.parse(await fs.readFile(path.join(homes.dir, ".config/opencode/opencode.json"), "utf-8"));
    expect(saved.theme).toBe("dark");
    expect(saved.provider.switchboard.options.baseURL).toBe("http://127.0.0.1:20128/v1");
  });

  it("GET 200 with activeModel:null when model is a non-string (hand-edited config)", async () => {
    await freshHome();
    await homeFile(".config/opencode/opencode.json", '{"model": {"nested": true}}');

    const res = await opencodeGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installed).toBe(true);
    expect(body.opencode.activeModel).toBeNull();
  });
});

describe("cowork-settings POST baseUrl (T122)", () => {
  const post = (baseUrl) => coworkPOST(new Request("http://localhost/api/cli-tools/cowork-settings", {
    method: "POST",
    body: JSON.stringify({ baseUrl, apiKey: "sk_x", models: ["m1"] }),
  }));

  const coworkLibDir = (platform) => {
    if (platform === "darwin") {
      return path.join(homes.dir, "Library", "Application Support", "Claude-3p", "configLibrary");
    }
    if (platform === "win32") {
      return path.join(process.env.LOCALAPPDATA, "Claude-3p", "configLibrary");
    }
    return path.join(homes.dir, ".config", "Claude-3p", "configLibrary");
  };

  it.each(["darwin", "linux", "win32"])("appends /v1 when missing and stores the normalized URL (%s)", async (platform) => {
    await freshHome();
    const prevPlatform = homes.platform;
    const prevLocalApp = process.env.LOCALAPPDATA;
    homes.platform = platform;
    if (platform === "win32") process.env.LOCALAPPDATA = path.join(homes.dir, "AppData", "Local");
    try {
    const res = await post("http://x");
    expect(res.status).toBe(200);

    const libDir = coworkLibDir(platform);
    const files = await fs.readdir(libDir);
    const meta = JSON.parse(await fs.readFile(path.join(libDir, "_meta.json"), "utf-8"));
    expect(files).toContain(`${meta.appliedId}.json`);
    const cfg = JSON.parse(await fs.readFile(path.join(libDir, `${meta.appliedId}.json`), "utf-8"));
    expect(cfg.inferenceGatewayBaseUrl).toBe("http://x/v1");
    // Default plugins must still be persisted as managedMcpServers (GET reads them back).
    expect(Array.isArray(cfg.managedMcpServers) && cfg.managedMcpServers.length > 0).toBe(true);
    } finally {
      homes.platform = prevPlatform;
      if (prevLocalApp === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocalApp;
    }
  });

  it("rejects empty and malformed baseUrls with 400", async () => {
    await freshHome();
    expect((await post("")).status).toBe(400);
    expect((await post("not-a-url")).status).toBe(400);
  });
});

describe("deepseek-tui-settings DELETE (T123)", () => {
  it("restores a Switchboard-pointed config even when the backup is gone", async () => {
    await freshHome();
    await homeFile(".deepseek/config.toml", [
      'provider = "openai"',
      "",
      "[providers.openai]",
      'base_url = "http://127.0.0.1:20128/v1"',
      'api_key = "sk_switchboard"',
      'model = "m1"',
      "",
    ].join("\n"));

    const res = await deepseekDELETE();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/restored/i);

    const after = await fs.readFile(path.join(homes.dir, ".deepseek/config.toml"), "utf-8");
    expect(after).not.toContain('provider = "openai"');
    expect(after).not.toContain("127.0.0.1:20128");
  });
});

describe("gemini-cli-settings GET (T124)", () => {
  it("returns 200 with empty models when settings.json is corrupt", async () => {
    await freshHome();
    await homeFile(".gemini/settings.json", "{ not json !!!");

    const res = await geminiGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installed).toBe(true);
    expect(body.settings.models).toEqual([]);
  });
});

describe("local Apply without apiKey defaults to sk_switchboard (T51/T78 route halves)", () => {
  const body = JSON.stringify({ baseUrl: "http://127.0.0.1:20128", apiKey: null, models: ["p/m1"] });

  it("droid-settings never persists the literal your_api_key", async () => {
    await freshHome();
    const res = await droidPOST(new Request("http://localhost/api/cli-tools/droid-settings", { method: "POST", body }));
    expect(res.status).toBe(200);
    const text = await fs.readFile(path.join(homes.dir, ".factory", "settings.json"), "utf-8");
    expect(text).not.toContain("your_api_key");
    expect(text).toContain("sk_switchboard");
  });

  it("openclaw-settings never persists the literal your_api_key", async () => {
    await freshHome();
    const res = await openclawPOST(new Request("http://localhost/api/cli-tools/openclaw-settings", { method: "POST", body }));
    expect(res.status).toBe(200);
    const cfg = JSON.parse(await fs.readFile(path.join(homes.dir, ".openclaw", "openclaw.json"), "utf-8"));
    expect(cfg.models.providers.switchboard.apiKey).toBe("sk_switchboard");
  });
});
