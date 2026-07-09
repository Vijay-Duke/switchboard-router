// @ts-check
import { createHash } from "node:crypto";

const SCOPE_FIELDS = [
  "provider",
  "authType",
  "apiType",
  "baseUrl",
  "resourceUrl",
  "region",
  "projectId",
  "accountId",
  "azureEndpoint",
  "apiVersion",
  "deployment",
  "organization",
  "chatgptAccountId",
  "workspaceId",
  "tenantId",
];

function cleanValue(value) {
  if (typeof value !== "string") return value == null ? null : String(value);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/g, "").toLowerCase();
  return trimmed;
}

/**
 * Fingerprint the non-secret connection dimensions that affect model
 * availability. Secrets such as access tokens and API keys are intentionally
 * excluded.
 *
 * @param {Record<string, any>} connection
 * @returns {string}
 */
export function buildModelProbeScopeKey(connection = {}) {
  const providerSpecificData = connection.providerSpecificData || {};
  const source = { ...providerSpecificData, ...connection };
  delete source.providerSpecificData;

  const scope = {};
  for (const field of SCOPE_FIELDS) {
    const value = cleanValue(source[field]);
    if (value != null) scope[field] = value;
  }

  const json = JSON.stringify(scope, Object.keys(scope).sort());
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 24);
  return `pmp:v1:${hash}`;
}
