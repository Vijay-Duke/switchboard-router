// @ts-check
import { getComboById } from "@/lib/db/index.js";
import {
  ComboWriteError,
  updateComboStrategyChecked,
} from "@/lib/combos/comboWrites.js";
import { fail, ok, requireManagementAuth } from "../../../_lib/http.js";

export const dynamic = "force-dynamic";

/**
 * PUT /api/mgmt/v1/combos/:id/strategy
 * @param {Request} request
 * @param {{ params: Promise<{ id: string }> }} context
 */
export async function PUT(request, { params }) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const combo = await getComboById(id);
    if (!combo) return fail(404, "Combo not found", "not_found");

    const strategy = await updateComboStrategyChecked(combo.name, await request.json());
    return ok({ combo: combo.name, strategy });
  } catch (error) {
    if (error instanceof ComboWriteError) {
      return fail(error.status || 400, error.message);
    }
    return fail(500, "Failed to update combo strategy");
  }
}
