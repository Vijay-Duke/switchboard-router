import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-config-import-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("configImporter", () => {
  it("imports YAML configuration with connections, aliases, combos and keys", async () => {
    const { parseConfigContent, importConfig } = await import("../../src/lib/configImporter.js");
    const {
      getProviderConnections,
      getModelAliases,
      getCombos,
      getApiKeys,
    } = await import("../../src/lib/db/index.js");

    const yaml = `
providers:
  - provider: openrouter
    name: main-openrouter
    apiKey: sk-or-test-123
    priority: 0
  - provider: deepseek
    name: backup-deepseek
    apiKey: sk-ds-test-456
    priority: 1

aliases:
  "gpt-4*": "openai/gpt-4.1"
  "fast-model": "openrouter/stealth/ox-alpha"

combos:
  - name: code-flow
    models:
      - openrouter/stealth/ox-alpha
      - deepseek/deepseek-r1
    description: "Multi-provider coding combo"

api_keys:
  - name: dev-agent-key
    key: sk_switchboard_dev_1
    role: user
`;

    const parsed = parseConfigContent(yaml);
    expect(parsed.providers).toHaveLength(2);
    expect(parsed.aliases["gpt-4*"]).toBe("openai/gpt-4.1");

    const stats = await importConfig(yaml);
    expect(stats.connections).toBe(2);
    expect(stats.aliases).toBe(2);
    expect(stats.combos).toBe(1);
    expect(stats.keys).toBe(1);

    const connections = await getProviderConnections();
    expect(connections).toHaveLength(2);
    expect(connections.find((c) => c.provider === "openrouter")?.apiKey).toBe("sk-or-test-123");

    const aliases = await getModelAliases();
    expect(aliases["gpt-4*"]).toBe("openai/gpt-4.1");
    expect(aliases["fast-model"]).toBe("openrouter/stealth/ox-alpha");

    const combos = await getCombos();
    expect(combos).toHaveLength(1);
    expect(combos[0].name).toBe("code-flow");

    const keys = await getApiKeys();
    expect(keys.some((k) => k.name === "dev-agent-key")).toBe(true);
  });
});
