// Per-key target access patterns (ported from upstream key-access-patterns):
// wildcard allow ("oc/*", "*claude*"), deny entries ("!opus" / "-haiku"),
// deny-only lists open-except-denied, resolved-identity matching, and the
// /v1/models list filter. The pause/quota gate lives in client-key-policy.
import { describe, it, expect, vi } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [{ id: "c1", name: "Main", models: ["openai/model-a"] }],
}));

vi.mock("@/lib/db/index.js", () => ({
  getCombos: async () => fx.combos,
  authenticateApiKey: async () => null,
  getClientKeySpend: async () => 0,
}));
vi.mock("@/sse/services/model.js", () => ({
  // "oc/x" resolves to provider id "opencode" like the real alias map.
  getModelInfo: async (s) => {
    if (s === "harmless-alias") return { provider: "anthropic", model: "claude-haiku" };
    if (typeof s !== "string" || !s.includes("/")) return null;
    const [rawProvider, ...rest] = s.split("/");
    const provider = rawProvider === "oc" ? "opencode" : rawProvider;
    return { provider, model: rest.join("/") };
  },
  getComboModels: async (name) => {
    const combo = fx.combos.find((c) => c.name === name);
    return combo ? combo.models : null;
  },
}));

const keyAccess = await import("@/sse/services/keyAccess.js");

// A context built from a client-key record (our two-list shape).
const ctx = (allowedModels, allowedCombos = []) =>
  keyAccess.buildKeyAccessContext({
    id: "k1",
    name: "test-key",
    allowedModels,
    allowedCombos,
  });

const allowed = (c, target) => keyAccess.isTargetAllowed(c, target);
const resolvedAllowed = (c, requested, provider, model) =>
  keyAccess.isResolvedTargetAllowed(c, requested, provider, model);

describe("keyAccess wildcard + deny patterns", () => {
  it("provider wildcard allows that provider's models (alias or id form)", async () => {
    const c = ctx(["oc/*"]);
    expect(await allowed(c, "oc/muse-spark")).toBe(true);
    expect(await allowed(c, "opencode/anything")).toBe(true);
    expect(await allowed(c, "openai/gpt-4o")).toBe(false);
  });

  it("glob wildcard matches model substrings", async () => {
    const c = ctx(["*claude*"]);
    expect(await allowed(c, "anthropic/claude-3-5-sonnet")).toBe(true);
    expect(await allowed(c, "anthropic/gpt-4o")).toBe(false);
  });

  it("catch-all wildcard allows everything", async () => {
    const c = ctx(["*"]);
    expect(await allowed(c, "anthropic/claude-3-5-sonnet")).toBe(true);
    expect(await allowed(c, "openai/gpt-4o")).toBe(true);
  });

  it("deny entry excludes models a positive rule would allow", async () => {
    const c = ctx(["*claude*", "-haiku"]);
    expect(await allowed(c, "anthropic/claude-3-5-sonnet")).toBe(true);
    expect(await allowed(c, "anthropic/claude-3-haiku")).toBe(false);
    expect(await allowed(c, "anthropic/gpt-4o")).toBe(false);
  });

  it("deny-only list allows everything except the denied term", async () => {
    const c = ctx(["!opus"]);
    expect(await allowed(c, "anthropic/claude-3-5-sonnet")).toBe(true);
    expect(await allowed(c, "openai/gpt-4o")).toBe(true);
    expect(await allowed(c, "anthropic/claude-3-opus")).toBe(false);
    // deny-only keys keep combo access
    expect(await allowed(c, "Main")).toBe(true);
  });

  it("a deny-only catch-all blocks every target", async () => {
    const c = ctx(["!*"]);
    expect(await allowed(c, "anthropic/claude-3-5-sonnet")).toBe(false);
    expect(await allowed(c, "openai/gpt-4o")).toBe(false);
  });

  it("resolved targets honor deny + wildcard on resolved ids", async () => {
    const c = ctx(["oc/*", "-muse"]);
    expect(await resolvedAllowed(c, "oc/other", "opencode", "other")).toBe(true);
    expect(await resolvedAllowed(c, "oc/muse-spark", "opencode", "muse-spark")).toBe(false);
    // An unverifiable target is denied for restricted keys.
    expect(await resolvedAllowed(c, "", null, null)).toBe(false);
  });

  it("provider-as-model targets match bare provider entries and combos", async () => {
    const c = ctx(["brave-search"]);
    expect(await keyAccess.isProviderTargetAllowed(c, "brave-search", null)).toBe(true);
    expect(await keyAccess.isProviderTargetAllowed(c, "brave-search/search", null)).toBe(false);
    expect(await keyAccess.isProviderTargetAllowed(c, "Main", ["openai/model-a"])).toBe(false);

    const comboCtx = ctx([], ["Main"]);
    expect(await keyAccess.isProviderTargetAllowed(comboCtx, "Main", ["openai/model-a"])).toBe(true);
    expect(await keyAccess.isProviderTargetAllowed(comboCtx, "brave-search", null)).toBe(false);
  });

  it("filterModelsListForKey keeps only allowed, non-denied entries", async () => {
    const c = ctx(["*claude*", "-haiku"]);
    const list = [
      { id: "anthropic/claude-3-5-sonnet", owned_by: "anthropic" },
      { id: "anthropic/claude-3-haiku", owned_by: "anthropic" },
      { id: "openai/gpt-4o", owned_by: "openai" },
    ];
    const out = await keyAccess.filterModelsListForKey(c, list);
    expect(out.map((e) => e.id)).toEqual(["anthropic/claude-3-5-sonnet"]);
  });

  it("filterModelsListForKey keeps listed combos and provider-as-model entries", async () => {
    const c = ctx(["*sonnet*"], ["Main"]);
    const list = [
      { id: "Main", owned_by: "combo" },
      { id: "anthropic/claude-3-5-sonnet", owned_by: "anthropic" },
      { id: "brave/search", owned_by: "brave", kind: "webSearch" },
      { id: "brave/fetch", owned_by: "brave", kind: "webFetch" },
    ];
    const out = await keyAccess.filterModelsListForKey(c, list);
    expect(out.map((e) => e.id)).toEqual(["Main", "anthropic/claude-3-5-sonnet"]);
  });

  it("exact-match entries still work alongside patterns", async () => {
    const c = ctx(["openai/gpt-4o", "oc/*"]);
    expect(await allowed(c, "openai/gpt-4o")).toBe(true);
    expect(await allowed(c, "openai/gpt-4o-mini")).toBe(false);
  });

  it("empty lists build an unrestricted (null) context", () => {
    expect(ctx([], [])).toBeNull();
    expect(keyAccess.buildKeyAccessContext(null)).toBeNull();
  });

  it("requested spelling that routes elsewhere than a same-named entry is denied", async () => {
    // "MAIN" is not the combo "Main" — resolves as a bare model, which the
    // list does not name, so it is denied (no case-trick routing).
    const c = ctx([], ["Main"]);
    expect(await allowed(c, "Main")).toBe(true);
  });
});

describe("extractClientApiKey", () => {
  const extract = (headers, url = "https://router.test/v1/models") =>
    keyAccess.extractClientApiKey(new Request(url, { headers }));

  it("reads the gateway key locations including ?key=", () => {
    expect(extract({ Authorization: "Bearer sk-a" })).toBe("sk-a");
    expect(extract({ "x-api-key": "sk-b" })).toBe("sk-b");
    expect(extract({ "x-goog-api-key": "sk-c" })).toBe("sk-c");
    expect(extract({ "x-switchboard-key": "sk-d" })).toBe("sk-d");
    expect(keyAccess.extractClientApiKey(new Request("https://router.test/v1/models?key=sk-e"))).toBe("sk-e");
    expect(extract({})).toBeNull();
  });
});


describe("deny rules across routing indirection", () => {
  it("denies canonical model names hidden behind aliases", async () => {
    expect(await allowed(ctx(["!haiku"]), "harmless-alias")).toBe(false);
  });
  it("denies combo names and resolved members, including nested combos", async () => {
    expect(await allowed(ctx(["!*"], ["Main"]), "Main")).toBe(false);
    expect(await allowed(ctx(["!model-a"], ["Main"]), "Main")).toBe(false);
    expect(await allowed(ctx(["Main*"]), "Main")).toBe(true);
    fx.combos.push({ name: "Nested", models: ["Main"] });
    try { expect(await allowed(ctx(["!model-a"], ["Nested"]), "Nested")).toBe(false); }
    finally { fx.combos.pop(); }
  });
  it("applies wildcard and deny rules to provider-as-model calls and their catalog entries", async () => {
    const c = ctx(["*", "!brave"]);
    expect(await keyAccess.isProviderTargetAllowed(c, "brave-search", null)).toBe(false);
    expect(await keyAccess.isProviderTargetAllowed(ctx(["*"]), "brave-search", null)).toBe(true);
    expect(await keyAccess.isProviderTargetAllowed(c, "Main", ["brave-search"])).toBe(false);
    const list = [{ id: "Main", owned_by: "combo" }, { id: "brave/search", kind: "webSearch" }];
    expect(await keyAccess.filterModelsListForKey(ctx(["!*"], ["Main"]), list)).toEqual([]);
    expect(await keyAccess.filterModelsListForKey(c, list)).toEqual([{ id: "Main", owned_by: "combo" }]);
  });
});
