export const DEFAULT_PROVIDER_LATENCY_GUARD_MS = 20000;

const providerRotation = new Map();

export function providerOf(modelStr) {
  const value = typeof modelStr === "string" ? modelStr : String(modelStr ?? "");
  const slash = value.indexOf("/");
  return slash === -1 ? value : value.slice(0, slash);
}

function finiteValue(values, provider, fallback) {
  const value = values?.[provider];
  return Number.isFinite(value) ? value : fallback;
}

function isLatencyGuarded(providerLatencyMs, provider, guardMs) {
  const latency = providerLatencyMs?.[provider];
  return Number.isFinite(latency) && latency > guardMs;
}

function distinctProviders(models) {
  const seen = new Set();
  const providers = [];
  for (const model of models) {
    const provider = providerOf(model);
    if (!seen.has(provider)) {
      seen.add(provider);
      providers.push(provider);
    }
  }
  return providers;
}

function providerRanks(providers, strategy, opts) {
  const ranks = new Map();
  if (strategy === "priority") {
    const order = Array.isArray(opts.providerOrder) ? opts.providerOrder : [];
    for (const provider of providers) {
      const index = order.indexOf(provider);
      ranks.set(provider, index === -1 ? order.length : index);
    }
    return ranks;
  }
  if (strategy === "round-robin") {
    const key = opts.rotationKey ?? "__default__";
    const count = providerRotation.get(key) || 0;
    providerRotation.set(key, count + 1);
    const start = count % providers.length;
    for (let index = 0; index < providers.length; index++) {
      ranks.set(providers[(start + index) % providers.length], index);
    }
    return ranks;
  }
  for (const provider of providers) {
    const quota = opts.providerQuota?.[provider];
    // quota-known (claude/codex via autoPing) ranked by headroom; others fall back to availability/usage.
    const rank = strategy === "fastest"
      ? finiteValue(opts.providerLatencyMs, provider, Infinity)
      : strategy === "quota-first"
        ? Number.isFinite(quota)
          ? 100 - quota
          : 1e6 + finiteValue(opts.providerUsage, provider, 0)
        : providers.indexOf(provider);
    ranks.set(provider, rank);
  }
  return ranks;
}

export function orderModelsByProvider(models, opts = {}) {
  const strategy = opts.strategy ?? "off";
  if (!Array.isArray(models) || models.length < 2 || strategy === "off") return models;

  const providers = distinctProviders(models);
  const ranks = providerRanks(providers, strategy, opts);
  const guardMs = Number.isFinite(opts.guardMs)
    ? opts.guardMs
    : DEFAULT_PROVIDER_LATENCY_GUARD_MS;

  return models
    .map((model, index) => {
      const provider = providerOf(model);
      return {
        model,
        index,
        rank: ranks.get(provider) ?? providers.length,
        demoted: isLatencyGuarded(opts.providerLatencyMs, provider, guardMs),
      };
    })
    .sort((a, b) => {
      if (a.demoted !== b.demoted) return Number(a.demoted) - Number(b.demoted);
      if (a.demoted) return a.index - b.index;
      return a.rank - b.rank || a.index - b.index;
    })
    .map(({ model }) => model);
}

export function resetProviderRotation() {
  providerRotation.clear();
}
