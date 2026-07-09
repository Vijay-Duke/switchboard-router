// @ts-check
import { canonicalModelId } from "./canonicalId.js";

function getModelId(model) {
  if (typeof model === "string") return model;
  return model?.id || model?.modelId || model?.model || model?.name || "";
}

function getModelName(model, id) {
  if (typeof model === "string") return id;
  return model?.name || model?.displayName || model?.display_name || id;
}

function getModelKind(model) {
  if (typeof model === "string") return "llm";
  return model?.kind || model?.type || "llm";
}

function getProbeKey(kind, canonicalId) {
  return `${kind || "llm"}|${canonicalId}`;
}

/**
 * @param {{ models: any[], probes?: Array<{ modelId: string, kind: string, status: string, latencyMs?: number|null, checkedAt?: string }>, providerAlias?: string, skipFreshOk?: boolean, freshOkMs?: number }} options
 */
export function prepareProbeModels(options) {
  const models = Array.isArray(options?.models) ? options.models : [];
  const probes = Array.isArray(options?.probes) ? options.probes : [];
  const providerAlias = options?.providerAlias || "";
  const freshOkMs = Math.max(0, Number(options?.freshOkMs || 0));
  const skipFreshOk = options?.skipFreshOk === true && freshOkMs > 0;
  const now = Date.now();

  const probeByKey = new Map();
  for (const probe of probes) {
    if (!probe?.modelId) continue;
    probeByKey.set(getProbeKey(probe.kind || "llm", probe.modelId), probe);
  }

  const seen = new Set();
  const eligible = [];
  const skippedDead = [];
  const skippedFreshOk = [];
  const cachedOk = [];
  let invalid = 0;
  let duplicates = 0;

  for (const model of models) {
    const id = String(getModelId(model)).trim();
    if (!id) {
      invalid += 1;
      continue;
    }
    const kind = String(getModelKind(model) || "llm").trim() || "llm";
    const canonicalId = canonicalModelId(id, providerAlias);
    if (!canonicalId) {
      invalid += 1;
      continue;
    }
    const key = getProbeKey(kind, canonicalId);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);

    const probe = probeByKey.get(key);
    const candidate = {
      id,
      modelId: id,
      canonicalId,
      name: getModelName(model, id),
      kind,
      type: kind,
      fullModel: typeof model === "object" ? model.fullModel : undefined,
    };

    if (probe?.status === "dead") {
      skippedDead.push({ ...candidate, checkedAt: probe.checkedAt, failureClass: probe.failureClass || null });
      continue;
    }

    if (probe?.status === "ok") {
      cachedOk.push({ ...candidate, latencyMs: probe.latencyMs ?? null, checkedAt: probe.checkedAt });
      const checked = probe.checkedAt ? Date.parse(probe.checkedAt) : NaN;
      if (skipFreshOk && Number.isFinite(checked) && now - checked <= freshOkMs) {
        skippedFreshOk.push({ ...candidate, latencyMs: probe.latencyMs ?? null, checkedAt: probe.checkedAt });
        continue;
      }
    }

    eligible.push(candidate);
  }

  return {
    eligible,
    skippedDead,
    skippedFreshOk,
    cachedOk,
    stats: {
      total: models.length,
      invalid,
      duplicates,
      skippedDead: skippedDead.length,
      skippedFreshOk: skippedFreshOk.length,
      cachedOk: cachedOk.length,
      eligible: eligible.length,
    },
  };
}
