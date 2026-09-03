// @ts-check
import OverviewClient from "./OverviewClient";
import { getLocalEndpointPort } from "@/lib/appUpdater";
import { loadProvidersPage, loadCombosPage } from "@/lib/dashboard/loaders";
import { getApiKeys, getPromotedLearningVersion } from "@/lib/db/index.js";

/**
 * Dashboard home = Overview (live endpoint + real combo strategy summary).
 */
export default async function DashboardPage() {
  let providerCount = 0;
  let readyProviderCount = 0;
  let keyCount = 0;
  let comboCount = 0;
  /** @type {any} */
  let defaultCombo = null;
  /** @type {any} */
  let learningSummary = null;
  /** @type {string|null} */
  let loadError = null;
  /** @param {unknown} e */
  const recordLoadError = (e) => {
    if (!loadError) {
      const message =
        e && typeof e === "object" && "message" in e
          ? String(/** @type {{ message: unknown }} */ (e).message)
          : "";
      loadError = message || "Failed to read dashboard data";
    }
  };

  try {
    const [providersData, keys, combosData] = await Promise.all([
      loadProvidersPage().catch((e) => {
        recordLoadError(e);
        return { connections: [], nodes: [] };
      }),
      getApiKeys().catch((e) => {
        recordLoadError(e);
        return [];
      }),
      loadCombosPage().catch((e) => {
        recordLoadError(e);
        return { combos: [], settings: {} };
      }),
    ]);

    const connections = providersData?.connections || [];
    const providerIds = new Set(
      connections.map((c) => c.provider || c.providerId).filter(Boolean)
    );
    providerCount = providerIds.size || connections.length;
    readyProviderCount = new Set(
      connections
        .filter((c) => c.isActive !== false && (c.testStatus === "active" || c.testStatus === "success"))
        .map((c) => c.provider || c.providerId)
        .filter(Boolean)
    ).size;

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
        routerModel: strategy === "auto" ? (strat.routerModel || null) : null,
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
  } catch (e) {
    /* overview still renders shell, but flags the failure instead of
       looking like an empty account */
    recordLoadError(e);
  }

  return (
    <OverviewClient
      initialData={{
        providerCount,
        readyProviderCount,
        keyCount,
        comboCount,
        defaultCombo,
        learningSummary,
        loadError,
        endpointHost: `127.0.0.1:${getLocalEndpointPort()}`,
      }}
    />
  );
}
