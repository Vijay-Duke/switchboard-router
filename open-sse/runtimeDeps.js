/**
 * M11: injectable deps so open-sse never statically imports the Next DB layer.
 * App wires real implementations via setOpenSseDeps() at startup.
 */

const NOOP = async () => {};
const NOOP_SYNC = () => {};

/** @type {Record<string, any>} */
let deps = {
  getSettings: async () => ({}),
  trackPendingRequest: NOOP_SYNC,
  appendRequestLog: NOOP,
  saveRequestDetail: NOOP,
  saveRequestUsage: NOOP,
  // routing repo surface used by scheduler/optimizer
  getRoutingEvents: async () => [],
  getClusterWorkerStats: async () => ({}),
  getPromotedLearningVersion: async () => null,
  createLearningVersion: NOOP,
  countRoutingEvents: async () => 0,
  listCombosWithRoutingEvents: async () => [],
  getLastScheduledLearnAt: async () => null,
  getClusterLatencyP50: async () => null,
  getComboModels: async () => null,
  // oauth helpers used by token refresh (optional)
  buildExternalIdpRefreshParams: null,
  createXaiService: null,
  fetchKiroProfileArn: null,
};

export function setOpenSseDeps(next = {}) {
  deps = { ...deps, ...next };
  return deps;
}

export function getOpenSseDeps() {
  return deps;
}

export function trackPendingRequest(...args) {
  return deps.trackPendingRequest?.(...args);
}

export function appendRequestLog(...args) {
  return deps.appendRequestLog?.(...args) ?? Promise.resolve();
}

export function saveRequestDetail(...args) {
  return deps.saveRequestDetail?.(...args) ?? Promise.resolve();
}

export function saveRequestUsage(...args) {
  return deps.saveRequestUsage?.(...args) ?? Promise.resolve();
}

export async function getSettings(...args) {
  return deps.getSettings ? deps.getSettings(...args) : {};
}

export async function getRoutingEvents(...args) {
  return deps.getRoutingEvents(...args);
}
export async function getClusterWorkerStats(...args) {
  return deps.getClusterWorkerStats(...args);
}
export async function getPromotedLearningVersion(...args) {
  return deps.getPromotedLearningVersion(...args);
}
export async function createLearningVersion(...args) {
  return deps.createLearningVersion(...args);
}
export async function countRoutingEvents(...args) {
  return deps.countRoutingEvents(...args);
}
export async function listCombosWithRoutingEvents(...args) {
  return deps.listCombosWithRoutingEvents(...args);
}
export async function getLastScheduledLearnAt(...args) {
  return deps.getLastScheduledLearnAt(...args);
}
export async function getClusterLatencyP50(...args) {
  return deps.getClusterLatencyP50(...args);
}

export async function getComboModels(...args) {
  return deps.getComboModels(...args);
}
