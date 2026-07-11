// @ts-check
/**
 * Server-only dashboard data loaders.
 * Call these from Server Components — never from client bundles.
 */

import {
  getSettings,
  getApiKeys,
  getProviderConnections,
  getProviderNodes,
  getCombos,
} from "@/lib/db/index.js";
import { redactSecrets } from "@/models";
import { getMachineId } from "@/shared/utils/machine";

/**
 * @typedef {object} SafeSettings
 * @property {boolean} requireLogin
 * @property {string} authMode
 * @property {boolean} oidcConfigured
 * @property {boolean} hasPassword
 * @property {boolean} [requireApiKey]
 * @property {Record<string, unknown>} [comboStrategies]
 */

/**
 * Strip secrets before sending settings to the client.
 * @param {Record<string, any>} settings
 * @returns {SafeSettings & Record<string, any>}
 */
function sanitizeSettings(settings) {
  const {
    password,
    oidcClientSecret,
    oidcIssuerUrl,
    oidcClientId,
    oidcScopes,
    oidcLoginLabel,
    authMode,
    requireLogin,
    ...safe
  } = settings || {};
  return {
    ...safe,
    requireLogin: false,
    authMode: "none",
    oidcConfigured: false,
    hasPassword: false,
  };
}

/**
 * Endpoint & Key page initial data.
 * @returns {Promise<{ machineId: string, keys: any[], settings: SafeSettings & Record<string, any> }>}
 */
export async function loadEndpointPage() {
  const [machineId, keys, settings] = await Promise.all([
    getMachineId(),
    getApiKeys(),
    getSettings(),
  ]);
  return {
    machineId,
    keys: keys || [],
    settings: sanitizeSettings(settings),
  };
}

/**
 * Providers list page initial data.
 * @returns {Promise<{ connections: any[], nodes: any[] }>}
 */
export async function loadProvidersPage() {
  const [connections, nodes] = await Promise.all([
    getProviderConnections(),
    getProviderNodes(),
  ]);
  return {
    connections: (connections || []).map(redactSecrets),
    nodes: nodes || [],
  };
}

/**
 * Combos page initial data (LLM combos only).
 * @returns {Promise<{ combos: any[], connections: any[], settings: SafeSettings & Record<string, any>, modelCaps: Record<string, any> }>}
 */
export async function loadCombosPage() {
  const [combos, connections, settings] = await Promise.all([
    getCombos(),
    getProviderConnections(),
    getSettings(),
  ]);
  const llmCombos = (combos || []).filter((c) => !c.kind || c.kind === "llm");
  /** @type {Record<string, any>} */
  let modelCaps = {};
  try {
    const { getProviderModelsCatalog } = await import("@/lib/dashboard/modelsCatalog.js");
    modelCaps = await getProviderModelsCatalog();
  } catch {
    modelCaps = {};
  }
  return {
    combos: llmCombos,
    connections: (connections || []).map(redactSecrets),
    settings: sanitizeSettings(settings),
    modelCaps,
  };
}

/**
 * Profile / settings page initial data.
 * @returns {Promise<{ settings: SafeSettings & Record<string, any>, machineId: string }>}
 */
export async function loadProfilePage() {
  const [settings, machineId] = await Promise.all([getSettings(), getMachineId()]);
  return {
    settings: sanitizeSettings(settings),
    machineId,
  };
}

