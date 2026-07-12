// @ts-check
import crypto from "node:crypto";

/** True when MANAGEMENT_TOKEN is configured (non-empty after trim). */
export function managementTokenConfigured() {
  return Boolean((process.env.MANAGEMENT_TOKEN || "").trim());
}

/** Constant-time compare of the request bearer token against MANAGEMENT_TOKEN.
 *  Returns false when MANAGEMENT_TOKEN is unset/empty (fails closed). */
export function isManagementTokenValid(request) {
  const configured = (process.env.MANAGEMENT_TOKEN || "").trim();
  if (!configured) return false;
  const auth = request?.headers?.get?.("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const presented = auth.slice(7).trim();
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
