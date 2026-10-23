// Compatible-provider connections (e.g. an Anthropic API node) face upstreams
// whose /models lists carry no capabilities, so /v1/models must advertise
// statically-known reasoning-effort levels for those models. Live upstream
// capabilities always win when present.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard-effort-caps-"));
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

const PROVIDER = "anthropic-compatible-test-uuid-1";

async function seedCompatibleConnection() {
  const { createProviderConnection } = await import("@/lib/db/index.js");
  await createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name: "acct-claude-api",
    isActive: true,
    apiKey: "sk-test",
    providerSpecificData: {
      prefix: "claude-api",
      baseUrl: "https://api.anthropic.com/v1",
      enabledModels: ["claude-opus-5-5", "claude-sonnet-4-6", "claude-opus-4-5-20251101", "claude-haiku-5-5", "claude-haiku-4-5", "plain-thing-1"],
    },
  });
}

async function modelsById() {
  const { buildModelsList } = await import("@/app/api/v1/models/route.js");
  const models = await buildModelsList(["llm"], { skipCompatibleDiscovery: true, signal: null });
  return new Map(models.map((m) => [m.id, m]));
}

function effortLevels(entry) {
  const eff = entry?.capabilities?.effort;
  if (!eff || eff.supported !== true) return null;
  return Object.keys(eff).filter((k) => k !== "supported").sort();
}

describe("/v1/models static effort advertisement for compatible providers", () => {
  it("advertises five effort levels for current claude models", { timeout: 20000 }, async () => {
    await seedCompatibleConnection();
    const byId = await modelsById();
    expect(effortLevels(byId.get("claude-api/claude-opus-5-5"))).toEqual(
      ["high", "low", "max", "medium", "xhigh"],
    );
  });

  it("omits xhigh where the family does not support it", async () => {
    await seedCompatibleConnection();
    const byId = await modelsById();
    expect(effortLevels(byId.get("claude-api/claude-sonnet-4-6"))).toEqual(
      ["high", "low", "max", "medium"],
    );
  });

  it("advertises low/medium/high only for Opus 4.5 (no max tier)", async () => {
    await seedCompatibleConnection();
    const byId = await modelsById();
    expect(effortLevels(byId.get("claude-api/claude-opus-4-5-20251101"))).toEqual(
      ["high", "low", "medium"],
    );
  });

  it("advertises five effort levels for Haiku 5.5", async () => {
    await seedCompatibleConnection();
    const byId = await modelsById();
    expect(effortLevels(byId.get("claude-api/claude-haiku-5-5"))).toEqual(
      ["high", "low", "max", "medium", "xhigh"],
    );
  });

  it("advertises no effort for models without known support", async () => {
    await seedCompatibleConnection();
    const byId = await modelsById();
    expect(byId.get("claude-api/plain-thing-1")?.capabilities?.effort).toBeUndefined();
    expect(byId.get("claude-api/claude-haiku-4-5")?.capabilities?.effort).toBeUndefined();
  });
});

describe("/v1/models relayed compatible-upstream capabilities", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function modelsViaDiscovery(catalog) {
    await seedCompatibleConnection();
    global.fetch = vi.fn().mockResolvedValue(Response.json(catalog));
    const { buildModelsList } = await import("@/app/api/v1/models/route.js");
    const models = await buildModelsList(["llm"], { skipCompatibleDiscovery: false, signal: null });
    return new Map(models.map((m) => [m.id, m]));
  }

  it("relays fewer upstream levels instead of the static allow-list", async () => {
    const byId = await modelsViaDiscovery({ data: [{
      id: "claude-opus-5-5",
      capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true } } },
    }] });
    expect(effortLevels(byId.get("claude-api/claude-opus-5-5"))).toEqual(["low", "medium"]);
  });

  it("respects an upstream effort ban instead of static fill", async () => {
    const byId = await modelsViaDiscovery({ data: [{
      id: "claude-opus-5-5",
      capabilities: { effort: { supported: false } },
    }] });
    expect(byId.get("claude-api/claude-opus-5-5")?.capabilities?.effort).toEqual({ supported: false });
  });

  it("relays caps for models with no static entry", async () => {
    const byId = await modelsViaDiscovery({ data: [{
      id: "plain-thing-1",
      capabilities: { effort: { supported: true, medium: { supported: true } } },
    }] });
    expect(effortLevels(byId.get("claude-api/plain-thing-1"))).toEqual(["medium"]);
  });

  it("intersects overstated upstream levels with the static allow-list", async () => {
    const byId = await modelsViaDiscovery({ data: [{
      id: "claude-sonnet-4-6",
      capabilities: { effort: {
        supported: true,
        low: { supported: true }, medium: { supported: true }, high: { supported: true },
        xhigh: { supported: true }, max: { supported: true },
      } },
    }] });
    expect(effortLevels(byId.get("claude-api/claude-sonnet-4-6"))).toEqual(
      ["high", "low", "max", "medium"],
    );
  });
});

describe("resolveEffortCapabilities", () => {
  async function resolve(upstreamEffort, staticEffort) {
    const { resolveEffortCapabilities } = await import(
      "../../open-sse/providers/capabilities.js"
    );
    const up = upstreamEffort === undefined ? null : { effort: upstreamEffort };
    const st = staticEffort === undefined ? null : { effort: staticEffort };
    return resolveEffortCapabilities(up, st);
  }
  const on = (supported) => ({ supported });

  it("intersects levels when both sides claim them", async () => {
    expect(await resolve(
      { supported: true, low: on(true), medium: on(true), high: on(true), xhigh: on(true), max: on(true) },
      { supported: true, low: on(true), medium: on(true), high: on(true), max: on(true) },
    )).toEqual({ effort: {
      supported: true, low: on(true), medium: on(true), high: on(true), max: on(true),
    } });
  });

  it("keeps the upstream claim when there is no overlap", async () => {
    const up = { supported: true, ultra: on(true) };
    expect(await resolve(up, { supported: true, low: on(true) })).toEqual({ effort: up });
  });

  it("respects an explicit upstream ban", async () => {
    expect(await resolve({ supported: false }, { supported: true, low: on(true) }))
      .toEqual({ effort: { supported: false } });
  });

  it("passes single-sided claims through untouched", async () => {
    const up = { supported: true, low: on(true) };
    const st = { supported: true, medium: on(true) };
    expect(await resolve(up, null)).toEqual({ effort: up });
    expect(await resolve(null, st)).toEqual({ effort: st });
    expect(await resolve(null, null)).toBeNull();
  });
});

describe("effortCapabilitiesForModelId", () => {
  it("builds the effort payload and strips alias prefixes", async () => {
    const { effortCapabilitiesForModelId } = await import(
      "../../open-sse/providers/capabilities.js"
    );
    expect(effortCapabilitiesForModelId("claude-api/claude-opus-5-5")).toEqual({
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: true },
        max: { supported: true },
      },
    });
    expect(effortCapabilitiesForModelId("gpt-5")).toBeNull();
    expect(effortCapabilitiesForModelId("")).toBeNull();
  });

  // Muse models carry max on the top tier (registry muse.js thinking.levels).
  // /v1/models must advertise it or Pi's /thinking picker caps at high —
  // discovered models like muse-wonder never appear in the static catalog.
  it("advertises high and max for DeepSeek V4 models", async () => {
    const { effortCapabilitiesForModelId } = await import(
      "../../open-sse/providers/capabilities.js"
    );
    expect(effortCapabilitiesForModelId("deepseek-v4.1-flash-1017")).toEqual({
      effort: {
        supported: true,
        high: { supported: true },
        max: { supported: true },
      },
    });
  });

  it("advertises max for muse spark and wonder models", async () => {
    const { effortCapabilitiesForModelId } = await import(
      "../../open-sse/providers/capabilities.js"
    );
    for (const id of [
      "muse/muse-spark-1.3",
      "muse/muse-wonder-1.0-contributor",
      "muse/muse-wonder-full-1.0-contributor",
      "muse-spark-1.3",
    ]) {
      expect(effortCapabilitiesForModelId(id)?.effort).toEqual({
        supported: true,
        minimal: { supported: true },
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: true },
        max: { supported: true },
      });
    }
  });
});
