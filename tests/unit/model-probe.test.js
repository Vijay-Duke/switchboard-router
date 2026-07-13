// @ts-check
import { describe, it, expect, vi } from "vitest";
import { classifyFailure } from "@/lib/model-probe/classifyFailure.js";
import { canonicalModelId } from "@/lib/model-probe/canonicalId.js";
import { buildModelProbeScopeKey } from "@/lib/model-probe/scopeKey.js";
import { clampProbeOptions, MODEL_PROBE_CAPS } from "@/lib/model-probe/caps.js";
import { prepareProbeModels } from "@/lib/model-probe/prepareModels.js";
import { runBatch, runBatches } from "@/lib/model-probe/runBatch.js";
import {
  upsertProbeResult,
  getDeadModelIds,
  getProbesForScope,
  clearProbes,
} from "@/lib/db/repos/modelProbeRepo.js";

describe("model-probe classifier", () => {
  it("marks ok", () => {
    expect(classifyFailure({ ok: true })).toEqual({ status: "ok", failureClass: null });
  });
  it("marks 404 as dead not_found", () => {
    expect(classifyFailure({ ok: false, status: 404, error: "HTTP 404" }).status).toBe("dead");
  });
  it("marks 429 as retryable throttled", () => {
    const r = classifyFailure({ ok: false, status: 429, error: "HTTP 429 rate limit" });
    expect(r).toEqual({ status: "retryable", failureClass: "throttled" });
  });
  it("marks timeout as retryable", () => {
    const r = classifyFailure({ name: "TimeoutError", message: "The operation was aborted due to timeout" });
    expect(r.status).toBe("retryable");
    expect(r.failureClass).toBe("timeout");
  });
  it("marks 403 as dead access_denied", () => {
    expect(classifyFailure({ ok: false, status: 403, error: "HTTP 403 forbidden" }).failureClass).toBe(
      "access_denied",
    );
  });
  it("marks 401 as retryable auth", () => {
    expect(classifyFailure({ ok: false, status: 401, error: "HTTP 401" }).status).toBe("retryable");
  });
});

describe("canonicalModelId", () => {
  it("strips provider prefix and lowercases", () => {
    expect(canonicalModelId("xai/Grok-4.5", "xai")).toBe("grok-4.5");
  });
  it("strips models/ prefix", () => {
    expect(canonicalModelId("models/gemini-2.0-flash", "gemini")).toBe("gemini-2.0-flash");
  });
  it("dedupes casing", () => {
    expect(canonicalModelId("Claude-Sonnet", "claude")).toBe("claude-sonnet");
  });
});

describe("scopeKey", () => {
  it("is stable and ignores secrets", () => {
    const a = buildModelProbeScopeKey({
      provider: "bedrock",
      region: "us-east-1",
      accessToken: "secret-a",
      apiKey: "key-a",
      providerSpecificData: { region: "us-east-1", baseUrl: "https://example.com/" },
    });
    const b = buildModelProbeScopeKey({
      provider: "bedrock",
      region: "us-east-1",
      accessToken: "secret-b",
      apiKey: "key-b",
      providerSpecificData: { region: "us-east-1", baseUrl: "https://example.com" },
    });
    expect(a).toBe(b);
    expect(a.startsWith("pmp:v1:")).toBe(true);
  });
  it("changes when region changes", () => {
    const a = buildModelProbeScopeKey({ provider: "bedrock", region: "us-east-1" });
    const b = buildModelProbeScopeKey({ provider: "bedrock", region: "eu-west-1" });
    expect(a).not.toBe(b);
  });
});

describe("clampProbeOptions", () => {
  it("clamps concurrency and batch size", () => {
    const c = clampProbeOptions({ concurrency: 999, batchSize: 9999, timeoutMs: 999999 });
    expect(c.concurrency).toBe(MODEL_PROBE_CAPS.maxConcurrency);
    expect(c.batchSize).toBe(MODEL_PROBE_CAPS.maxBatchSize);
    expect(c.timeoutMs).toBe(MODEL_PROBE_CAPS.maxTimeoutMs);
  });
  it("uses defaults", () => {
    const c = clampProbeOptions({});
    expect(c.concurrency).toBe(MODEL_PROBE_CAPS.defaultConcurrency);
    expect(c.batchSize).toBe(MODEL_PROBE_CAPS.defaultBatchSize);
  });
});

describe("prepareProbeModels", () => {
  it("dedupes and skips dead", () => {
    const prepared = prepareProbeModels({
      providerAlias: "xai",
      models: [
        { id: "grok-4.5" },
        { id: "xai/grok-4.5" },
        { id: "dead-model" },
        { id: "ok-model" },
      ],
      probes: [
        { modelId: "dead-model", kind: "llm", status: "dead" },
        { modelId: "ok-model", kind: "llm", status: "ok", latencyMs: 12, checkedAt: new Date().toISOString() },
      ],
      skipFreshOk: true,
      freshOkMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(prepared.stats.duplicates).toBe(1);
    expect(prepared.stats.skippedDead).toBe(1);
    expect(prepared.eligible.map((m) => m.canonicalId)).toEqual(["grok-4.5"]);
  });

  it("handles 2000 models with duplicates (stress eligibility)", () => {
    const models = [];
    for (let i = 0; i < 2000; i += 1) {
      models.push({ id: `m-${i % 500}` }); // 4x dups → 500 unique
    }
    const probes = Array.from({ length: 100 }, (_, i) => ({
      modelId: `m-${i}`,
      kind: "llm",
      status: "dead",
    }));
    const prepared = prepareProbeModels({ models, probes, providerAlias: "bedrock" });
    expect(prepared.stats.eligible).toBe(400); // 500 unique - 100 dead
    expect(prepared.stats.skippedDead).toBe(100);
    expect(prepared.stats.duplicates).toBe(1500);
  });
});

describe("runBatch concurrency", () => {
  it("never exceeds concurrency and clamps batch size", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const ping = vi.fn(async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return { ok: true, latencyMs: 5, status: 200 };
    });

    const models = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}` }));
    const { results, caps } = await runBatch({
      models,
      providerAlias: "test",
      concurrency: 3,
      batchSize: 10,
      timeoutMs: 5000,
      ping,
    });
    expect(results).toHaveLength(10); // batch size clamp
    expect(caps.concurrency).toBe(3);
    expect(maxInflight).toBeLessThanOrEqual(3);
    expect(ping).toHaveBeenCalledTimes(10);
  });

  it("pins probe requests to the selected provider connection", async () => {
    const ping = vi.fn(async () => ({ ok: true, latencyMs: 1, status: 200 }));
    await runBatch({
      models: [{ id: "m1" }],
      providerAlias: "test",
      connectionId: "connection-123",
      ping,
    });
    expect(ping.mock.calls[0][3]).toMatchObject({ connectionId: "connection-123" });
  });

  it("runBatches processes all models in chunks", async () => {
    const ping = vi.fn(async () => ({ ok: false, status: 404, error: "HTTP 404 model not found", latencyMs: 1 }));
    const models = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}` }));
    const { results } = await runBatches({
      models,
      providerAlias: "test",
      concurrency: 4,
      batchSize: 10,
      ping,
    });
    expect(results).toHaveLength(25);
    expect(results.every((r) => r.probeStatus === "dead")).toBe(true);
  });

  it("publishes each completed model before the rest of the batch finishes", async () => {
    let releaseSlow;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const onResult = vi.fn();
    const ping = vi.fn(async (fullModel) => {
      if (!fullModel.endsWith("/fast")) await slowGate;
      return { ok: true, latencyMs: 1, status: 200 };
    });

    let settled = false;
    const batchPromise = runBatch({
      models: [{ id: "fast" }, { id: "slow-a" }, { id: "slow-b" }],
      providerAlias: "test",
      concurrency: 3,
      batchSize: 3,
      timeoutMs: 5000,
      ping,
      onResult,
    }).finally(() => { settled = true; });

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult.mock.calls[0][0].canonicalId).toBe("fast");
    expect(settled).toBe(false);

    releaseSlow();
    await batchPromise;
    expect(onResult).toHaveBeenCalledTimes(3);
  });

  it("aborts in-flight probes without publishing cancelled results", async () => {
    const controller = new AbortController();
    const onResult = vi.fn();
    const ping = vi.fn(async (_model, _kind, _baseUrl, options) => {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason || new Error("aborted")), { once: true });
      });
      return { ok: true, latencyMs: 1, status: 200 };
    });

    const batchPromise = runBatch({
      models: [{ id: "slow" }],
      providerAlias: "test",
      concurrency: 1,
      batchSize: 1,
      timeoutMs: 5000,
      ping,
      onResult,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(ping).toHaveBeenCalledTimes(1));
    controller.abort(new Error("cancelled"));
    await expect(batchPromise).rejects.toThrow("cancelled");
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe("modelProbeRepo", () => {
  it("upserts, lists dead, and clears", async () => {
    const providerId = `test-provider-${Date.now()}`;
    const scopeKey = "pmp:v1:testscope";
    await upsertProbeResult({
      providerId,
      scopeKey,
      modelId: "dead-1",
      kind: "llm",
      status: "dead",
      failureClass: "not_found",
      failureMessage: "HTTP 404",
    });
    await upsertProbeResult({
      providerId,
      scopeKey,
      modelId: "ok-1",
      kind: "llm",
      status: "ok",
      latencyMs: 42,
    });
    const dead = await getDeadModelIds(providerId, scopeKey, "llm");
    expect(dead).toContain("dead-1");
    expect(dead).not.toContain("ok-1");
    const all = await getProbesForScope(providerId, scopeKey);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const cleared = await clearProbes(providerId, scopeKey);
    expect(cleared).toBeGreaterThanOrEqual(2);
    expect(await getDeadModelIds(providerId, scopeKey)).toEqual([]);
  });
});
