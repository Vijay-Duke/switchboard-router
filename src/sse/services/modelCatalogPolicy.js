import { getSettings } from "@/lib/db/index.js";
import { extractClientApiKey, buildKeyAccessContext } from "./keyAccess.js";
import { authorizeClientKeyRequest, runWithClientKeyLease } from "./clientKeyPolicy.js";

// The public gateway guard handles unauthenticated catalog discovery. When a
// caller presents a key, apply its current policy before any live discovery,
// including paused/expired/quota-limited keys in optional-auth local mode.
export async function withModelCatalogPolicy(request, load) {
  const rawKey = extractClientApiKey(request);
  if (!rawKey) return load(null);
  const auth = await authorizeClientKeyRequest({ settings: await getSettings(), rawKey, request });
  if (!auth.ok) return auth.response;
  return runWithClientKeyLease(auth.lease, () => load(buildKeyAccessContext(auth.clientKey)));
}
