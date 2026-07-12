// @ts-check
import crypto from "node:crypto";

/** True when MANAGEMENT_TOKEN is configured (non-empty after trim). */
export function managementTokenConfigured() {
  return Boolean((process.env.MANAGEMENT_TOKEN || "").trim());
}

/** Constant-time compare of the request bearer token against MANAGEMENT_TOKEN.
 *  Returns false when MANAGEMENT_TOKEN is unset/empty (fails closed).
 *  Both sides are hashed to fixed-length digests before timingSafeEqual so no
 *  length branch can leak the configured token's length via timing. */
export function isManagementTokenValid(request) {
  const configured = (process.env.MANAGEMENT_TOKEN || "").trim();
  if (!configured) return false;
  const auth = request?.headers?.get?.("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const presented = auth.slice(7).trim();
  if (!presented) return false;
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}
