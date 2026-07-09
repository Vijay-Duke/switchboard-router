// @ts-check
import { pingModelByKind } from "@/app/api/models/test/ping.js";
import { canonicalModelId } from "./canonicalId.js";
import { classifyFailure } from "./classifyFailure.js";
import { clampProbeOptions } from "./caps.js";

function modelKind(model) {
  return model?.kind || model?.type || "llm";
}

function modelName(model) {
  return model?.name || model?.id || model?.modelId || model?.model || "";
}

function modelId(model) {
  return model?.id || model?.modelId || model?.model || model?.name || "";
}

async function runOne(model, options) {
  const id = String(modelId(model)).trim();
  const kind = String(modelKind(model)).trim() || "llm";
  const canonicalId = canonicalModelId(id, options.providerAlias);
  const fullModel = model.fullModel || `${options.providerAlias}/${id}`;
  const checkedAt = new Date().toISOString();
  const start = Date.now();

  try {
    const result = await options.ping(fullModel, kind, options.baseUrl, { timeoutMs: options.timeoutMs });
    const classified = classifyFailure(result);
    return {
      modelId: id,
      canonicalId,
      name: modelName(model) || id,
      kind,
      fullModel,
      ok: result.ok === true,
      latencyMs: result.latencyMs ?? (Date.now() - start),
      status: result.status ?? null,
      error: result.error || null,
      probeStatus: classified.status,
      failureClass: classified.failureClass,
      failureMessage: result.error || null,
      checkedAt,
    };
  } catch (error) {
    const classified = classifyFailure(error);
    return {
      modelId: id,
      canonicalId,
      name: modelName(model) || id,
      kind,
      fullModel,
      ok: false,
      latencyMs: Date.now() - start,
      status: null,
      error: error?.message || "Probe failed",
      probeStatus: classified.status,
      failureClass: classified.failureClass,
      failureMessage: error?.message || "Probe failed",
      checkedAt,
    };
  }
}

async function runPool(models, options) {
  const results = new Array(models.length);
  let next = 0;
  const workerCount = Math.min(options.concurrency, models.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < models.length) {
      const index = next;
      next += 1;
      results[index] = await runOne(models[index], options);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Run one clamped batch with bounded concurrency.
 *
 * @param {{ models: any[], providerAlias: string, concurrency?: number, batchSize?: number, timeoutMs?: number, baseUrl?: string, warmup?: boolean, ping?: typeof pingModelByKind }} options
 */
export async function runBatch(options) {
  const clamped = clampProbeOptions(options || {});
  const models = (Array.isArray(options?.models) ? options.models : []).slice(0, clamped.batchSize);
  const runOptions = {
    ...clamped,
    providerAlias: options.providerAlias,
    baseUrl: options.baseUrl,
    ping: options.ping || pingModelByKind,
  };
  if (!runOptions.providerAlias) throw new Error("providerAlias required");
  if (models.length === 0) return { results: [], caps: clamped };

  if (options.warmup && models.length > 1) {
    const [first, ...rest] = models;
    const firstResult = await runOne(first, runOptions);
    const restResults = await runPool(rest, runOptions);
    return { results: [firstResult, ...restResults], caps: clamped };
  }

  return { results: await runPool(models, runOptions), caps: clamped };
}

/**
 * Run an arbitrary list in sequential clamped batches.
 *
 * @param {{ models: any[], providerAlias: string, concurrency?: number, batchSize?: number, timeoutMs?: number, baseUrl?: string, warmup?: boolean, ping?: typeof pingModelByKind }} options
 */
export async function runBatches(options) {
  const clamped = clampProbeOptions(options || {});
  const all = Array.isArray(options?.models) ? options.models : [];
  const results = [];
  for (let start = 0; start < all.length; start += clamped.batchSize) {
    const chunk = all.slice(start, start + clamped.batchSize);
    const batch = await runBatch({
      ...options,
      ...clamped,
      models: chunk,
      warmup: options.warmup && start === 0,
    });
    results.push(...batch.results);
  }
  return { results, caps: clamped };
}
