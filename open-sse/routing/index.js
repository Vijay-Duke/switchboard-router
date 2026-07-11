export {
  handleAutoChat,
  invalidateCachedRoutes,
  extractAssistantText,
  clampExploration,
  EXPLORATION_RATE_CAP,
  STREAM_PROBE_IDLE_MS,
  hasStreamContent,
  hasJsonCompletion,
  isSseKeepaliveText,
  chunkHasCompletion,
  acceptWorkerResponse,
  probeStreamForContent,
  restreamFromProbe,
} from "./handleAutoChat.js";
export {
  buildRouterPrompt,
  healthFromStats,
  clusterLatencyRef,
} from "./buildRouterPrompt.js";
export { parseRouterPick, resolvePoolModel } from "./parseRouterResponse.js";
export { computeOutcomeScore } from "./scoring.js";
export { buildRequestSignals } from "./fingerprint.js";
export {
  runOptimizer,
  deriveRules,
  describeRuleGaps,
  computeReplayEval,
  buildBanditTable,
  buildBanditTableFromEvents,
  pickFewShots,
} from "./optimizer.js";
export {
  cached,
  invalidateRoutingCache,
  statsCacheKey,
  learningCacheKey,
} from "./routingCache.js";
export {
  costTier,
  rankByObjective,
  pickByObjective,
  objectivePromptText,
} from "./objective.js";
export { startAutoLearnScheduler, runAutoLearnTick } from "./scheduler.js";
