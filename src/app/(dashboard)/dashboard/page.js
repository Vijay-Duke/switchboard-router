// @ts-check
import OverviewClient from "./OverviewClient";
import { loadProvidersPage, loadCombosPage } from "@/lib/dashboard/loaders";
import { getApiKeys, getPromotedLearningVersion } from "@/lib/localDb";

/**
 * Dashboard home = Overview (live endpoint + real combo strategy summary).
 */
export default async function DashboardPage() {
  let providerCount = 0;
  let keyCount = 0;
  let comboCount = 0;
  /** @type {any} */
  let defaultCombo = null;
  /** @type {Array<{account: string, pct: number}>} */
  let quotas = [];
  /** @type {any} */
  let learningSummary = null;

  try {
    const [providersData, keys, combosData] = await Promise.all([
      loadProvidersPage().catch(() => ({ connections: [], nodes: [] })),
      getApiKeys().catch(() => []),
      loadCombosPage().catch(() => ({ combos: [], settings: {} })),
    ]);

    const connections = providersData?.connections || [];
    const providerIds = new Set(
      connections.map((c) => c.provider || c.providerId).filter(Boolean)
    );
    providerCount = providerIds.size || connections.length;

    for (const c of connections) {
      const used = c.quotaUsed ?? c.usagePercent ?? c.quotaPercent ?? null;
      if (used != null && !Number.isNaN(Number(used))) {
        quotas.push({
          account: c.name || c.email || c.connectionName || c.provider || "account",
          pct: Number(used),
        });
      }
    }

    keyCount = Array.isArray(keys) ? keys.length : 0;
    const comboList = combosData?.combos || [];
    comboCount = comboList.length;
    const settings = combosData?.settings || {};
    const strategies = settings.comboStrategies || {};

    // Prefer first Auto combo for routing card; else first combo
    const autoCombo =
      comboList.find((c) => strategies[c.name]?.fallbackStrategy === "auto") || null;
    const first = autoCombo || comboList[0] || null;

    if (first) {
      const models = first.models || first.workers || [];
      const strat = strategies[first.name] || {};
      const strategy =
        strat.fallbackStrategy || settings.comboStrategy || "fallback";
      defaultCombo = {
        name: first.name || first.id || "—",
        strategy,
        isAuto: strategy === "auto",
        routerModel: strategy === "auto" ? (strat.routerModel || "claude/claude-opus-4-8") : null,
        workerCount: Array.isArray(models) ? models.length : 0,
        objective: strategy === "auto" ? (strat.objective || "balanced") : null,
        exploration:
          strategy === "auto"
            ? `${Math.round((strat.explorationRate ?? 0.05) * 100)}%`
            : null,
        capacityAutoSwitch: strat.capacityAutoSwitch !== false,
        judgeModel: strategy === "fusion" ? (strat.judgeModel || "auto") : null,
      };

      if (strategy === "auto") {
        try {
          const promoted = await getPromotedLearningVersion(first.name);
          learningSummary = promoted
            ? {
                version: promoted.version,
                evalScore: promoted.evalScore,
                freezeLearning: !!strat.freezeLearning,
              }
            : {
                version: null,
                evalScore: null,
                freezeLearning: !!strat.freezeLearning,
              };
        } catch {
          learningSummary = { version: null, evalScore: null, freezeLearning: false };
        }
      }
    }
  } catch {
    /* overview still renders shell */
  }

  return (
    <OverviewClient
      initialData={{
        providerCount,
        keyCount,
        comboCount,
        defaultCombo,
        quotas,
        learningSummary,
      }}
    />
  );
}
