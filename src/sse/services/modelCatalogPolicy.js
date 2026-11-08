import { getSettings } from "@/lib/db/index.js";
import { extractClientApiKey, buildKeyAccessContext } from "./keyAccess.js";
import { authorizeClientKeyRequest } from "./clientKeyPolicy.js";

// The public gateway guard handles unauthenticated catalog discovery. When a
// caller presents a key, apply its current policy before any live discovery,
// including paused/expired keys in optional-auth local mode. Catalog reads
// neither consume inference budgets nor require unused inference quota.
export async function withModelCatalogPolicy(request, load) {
  const rawKey = extractClientApiKey(request);
  if (!rawKey) return load(null);
  const auth = await authorizeClientKeyRequest({ settings: await getSettings(), rawKey, request, metered: false });
  if (!auth.ok) return auth.response;
  return load(buildKeyAccessContext(auth.clientKey));
}
