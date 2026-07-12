// @ts-check
import { NextResponse } from "next/server";
import { isLocalRequest } from "@/dashboardGuard";
import { hasValidCliToken } from "@/shared/utils/cliToken.js";
import { isManagementTokenValid } from "@/lib/mgmt/token.js";

/** Wrap success payloads as the stable { v:1, data } envelope. */
export function ok(data, init) {
  return NextResponse.json({ v: 1, data }, { headers: { "Cache-Control": "no-store" }, ...(init || {}) });
}
/** Wrap errors as { v:1, error:{ message, code? } }. */
export function fail(status, message, code) {
  const error = code ? { message, code } : { message };
  return NextResponse.json({ v: 1, error }, { status, headers: { "Cache-Control": "no-store" } });
}
/** Route-level defense-in-depth auth (middleware already gates, but never trust one layer).
 *  Returns null when authorized, or a 401 `fail(...)` Response when not. */
export async function requireManagementAuth(request) {
  if (isLocalRequest(request)) return null;
  if (await hasValidCliToken(request)) return null;
  if (isManagementTokenValid(request)) return null;
  return fail(401, "Management API requires local access or a valid bearer token", "unauthorized");
}
