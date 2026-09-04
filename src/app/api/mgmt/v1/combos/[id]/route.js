// @ts-check
import { getComboById, getSettings } from "@/lib/db/index.js";
import {
  ComboWriteError,
  deleteComboWrite,
  updateComboWrite,
} from "@/lib/combos/comboWrites.js";
import { fail, ok, requireManagementAuth } from "../../_lib/http.js";

export const dynamic = "force-dynamic";

/** @param {Record<string, any>} combo @param {Record<string, any>} strategies */
function toComboData(combo, strategies) {
  const strategy = strategies?.[combo.name] || null;
  return {
    id: combo.id,
    name: combo.name,
    kind: combo.kind,
    models: combo.models,
    strategy,
    routerModel: strategy?.routerModel || null,
    fallbackStrategy: strategy?.fallbackStrategy || null,
  };
}

/**
 * GET /api/mgmt/v1/combos/:id
 * @param {Request} request
 * @param {{ params: Promise<{ id: string }> }} context
 */
export async function GET(request, { params }) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (typeof id !== "string" || !id.trim() || id.length > 200) {
      return fail(400, "Invalid combo id", "bad_request");
    }
    const combo = await getComboById(id);
    if (!combo) return fail(404, "Combo not found", "not_found");
    const settings = await getSettings();
    return ok(toComboData(combo, settings?.comboStrategies || {}));
  } catch {
    return fail(500, "Failed to fetch combo");
  }
}

/**
 * PUT /api/mgmt/v1/combos/:id
 * @param {Request} request
 * @param {{ params: Promise<{ id: string }> }} context
 */
export async function PUT(request, { params }) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body", "bad_request");
  }
  try {
    const { id } = await params;
    if (typeof id !== "string" || !id.trim() || id.length > 200) {
      return fail(400, "Invalid combo id", "bad_request");
    }
    const combo = await updateComboWrite(id, body);
    if (!combo) return fail(404, "Combo not found", "not_found");
    return ok(combo);
  } catch (error) {
    if (error instanceof ComboWriteError) {
      return fail(error.status || 400, error.message);
    }
    return fail(500, "Failed to update combo");
  }
}

/**
 * DELETE /api/mgmt/v1/combos/:id
 * @param {Request} request
 * @param {{ params: Promise<{ id: string }> }} context
 */
export async function DELETE(request, { params }) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    if (typeof id !== "string" || !id.trim() || id.length > 200) {
      return fail(400, "Invalid combo id", "bad_request");
    }
    const success = await deleteComboWrite(id);
    if (!success) return fail(404, "Combo not found", "not_found");
    return ok({ success: true });
  } catch (error) {
    if (error instanceof ComboWriteError) {
      return fail(error.status || 400, error.message);
    }
    return fail(500, "Failed to delete combo");
  }
}
