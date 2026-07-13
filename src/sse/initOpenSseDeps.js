/**
 * Wire open-sse runtime deps to the Next/app DB layer (M11).
 * Import once from any SSE entry so production is live.
 */
import { setOpenSseDeps } from "open-sse/runtimeDeps.js";
import {
  trackPendingRequest,
  appendRequestLog,
  saveRequestDetail,
  saveRequestUsage,
} from "@/lib/usageDb.js";
import { getSettings } from "@/lib/db/index.js";
import {
  getRoutingEvents,
  getClusterWorkerStats,
  getPromotedLearningVersion,
  createLearningVersion,
  countRoutingEvents,
  listCombosWithRoutingEvents,
  getLastScheduledLearnAt,
  getClusterLatencyP50,
} from "@/lib/db/repos/routingRepo.js";
import { getComboModels } from "./services/model.js";
import {
  getVaultEntry, putVaultEntry, searchVault, cleanupExpiredVault,
} from "@/lib/db/repos/vaultRepo.js";

let wired = false;

export function ensureOpenSseDeps() {
  if (wired) return;
  wired = true;
  setOpenSseDeps({
    getSettings,
    trackPendingRequest,
    appendRequestLog,
    saveRequestDetail,
    saveRequestUsage,
    getRoutingEvents,
    getClusterWorkerStats,
    getPromotedLearningVersion,
    createLearningVersion,
    countRoutingEvents,
    listCombosWithRoutingEvents,
    getLastScheduledLearnAt,
    getClusterLatencyP50,
    getComboModels,
    getVaultEntry,
    putVaultEntry,
    searchVault,
    cleanupExpiredVault,
    buildExternalIdpRefreshParams: async (...args) => {
      const mod = await import("@/lib/oauth/kiroExternalIdp.js");
      return mod.buildExternalIdpRefreshParams(...args);
    },
    createXaiService: async () => {
      const mod = await import("@/lib/oauth/services/xai.js");
      return new mod.XaiService();
    },
    fetchKiroProfileArn: async (...args) => {
      const mod = await import("@/lib/oauth/providers.js");
      return mod.fetchKiroProfileArn(...args);
    },
  });
}

ensureOpenSseDeps();
