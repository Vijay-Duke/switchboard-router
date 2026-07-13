// @ts-check

export const MODEL_CATALOG_HEADER = "X-Switchboard-Model-Catalog";

/**
 * Catalog requests marked by another Switchboard instance must not fan out to
 * compatible providers again, otherwise two gateways can recurse through each
 * other's /models endpoints.
 * @param {Request|undefined|null} request
 */
export function isModelCatalogDiscoveryRequest(request) {
  return request?.headers?.get?.(MODEL_CATALOG_HEADER) === "1";
}
