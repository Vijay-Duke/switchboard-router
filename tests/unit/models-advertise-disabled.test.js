// What does /v1/models advertise when a provider's connection is inactive —
// directly, via alias indirection, and via combo membership?
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-advertise-"));
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

const DS_MODEL = "ds/deepseek-chat";
const GLM_MODEL = "glm/glm-4.7";
const DS_ALIAS = "claude-ds-alpha";

async function ids() {
  const { buildModelsList } = await import("@/app/api/v1/models/route.js");
  const models = await buildModelsList(["llm"], { skipCompatibleDiscovery: true, signal: null });
  return models.map((m) => m.id);
}

async function seedConnection(provider, isActive) {
  const { createProviderConnection } = await import("@/lib/db/index.js");
  await createProviderConnection({
    provider, authType: "apikey", name: `acct-${provider}`,
    isActive, apiKey: "sk-test", providerSpecificData: {},
  });
}

describe("/v1/models advertising vs connection state", () => {
  it("advertises provider models when connection isActive=1", { timeout: 20000 }, async () => {
    await seedConnection("deepseek", true);
    expect(await ids()).toContain(DS_MODEL);
  });

  it("stops advertising when connection isActive=0", async () => {
    await seedConnection("deepseek", false);
    expect(await ids()).not.toContain(DS_MODEL);
  });

  it("hides a claude-gateway alias whose target provider is off", async () => {
    const { setModelAlias } = await import("@/lib/db/index.js");
    await seedConnection("deepseek", false);
    await setModelAlias(DS_ALIAS, DS_MODEL);
    expect(await ids()).not.toContain(DS_ALIAS);
  });

  it("keeps a claude-gateway alias whose target provider is on", { timeout: 20000 }, async () => {
    const { setModelAlias } = await import("@/lib/db/index.js");
    await seedConnection("deepseek", true);
    await setModelAlias(DS_ALIAS, DS_MODEL);
    expect(await ids()).toContain(DS_ALIAS);
  });

  it("hides a combo whose only member targets an inactive provider", async () => {
    const { createCombo } = await import("@/lib/db/index.js");
    await seedConnection("deepseek", false);
    await createCombo({ name: "combo-ds", models: [DS_MODEL] });
    expect(await ids()).not.toContain("combo-ds");
  });

  it("keeps a combo when another member's provider is active", { timeout: 20000 }, async () => {
    const { createCombo } = await import("@/lib/db/index.js");
    await seedConnection("deepseek", false);
    await seedConnection("glm", true);
    await createCombo({ name: "combo-mixed", models: [DS_MODEL, GLM_MODEL] });
    expect(await ids()).toContain("combo-mixed");
  });

  it("keeps a combo with undetermined prefixes (custom nodes) — fail-open", async () => {
    const { createCombo } = await import("@/lib/db/index.js");
    await seedConnection("deepseek", false);
    await createCombo({ name: "combo-node", models: ["mynode/some-model"] });
    expect(await ids()).toContain("combo-node");
  });
});

describe("/v1/models filtered by client-key access", () => {
  async function modelsFor(rawKey) {
    const { GET } = await import("@/app/api/v1/models/route.js");
    const headers = rawKey ? { Authorization: `Bearer ${rawKey}` } : {};
    const response = await GET(new Request("https://router.test/v1/models", { headers }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.object).toBe("list");
    return body.data.map((m) => m.id);
  }

  it("hides everything a restricted key may not call, including whole providers", { timeout: 20000 }, async () => {
    const { createApiKey, createCombo } = await import("@/lib/db/index.js");
    await seedConnection("deepseek", true);
    await seedConnection("glm", true);
    await createCombo({ name: "combo-ds", models: [DS_MODEL] });

    // Unrestricted caller sees both providers and the combo.
    const open = await modelsFor(null);
    expect(open).toContain(DS_MODEL);
    expect(open).toContain(GLM_MODEL);
    expect(open).toContain("combo-ds");

    // Restricted to glm/* + combo-ds: deepseek disappears, combo stays.
    const key = await createApiKey("Restricted", "machine-models", {
      allowedModels: ["glm/*"],
      allowedCombos: ["combo-ds"],
    });
    expect(key.key).toMatch(/^sk-/);
    const restricted = await modelsFor(key.key);
    expect(restricted).not.toContain(DS_MODEL);
    expect(restricted).toContain(GLM_MODEL);
    expect(restricted).toContain("combo-ds");

    // Deny entry removes the one denied model but keeps the rest of the provider.
    const denyKey = await createApiKey("Deny", "machine-models-2", {
      allowedModels: ["glm/*", "-glm-4.7"],
    });
    const denied = await modelsFor(denyKey.key);
    expect(denied).not.toContain(GLM_MODEL);
    expect(denied.some((id) => id.startsWith("glm/"))).toBe(true);
  });
});
