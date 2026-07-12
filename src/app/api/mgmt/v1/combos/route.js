// @ts-check
import { getCombos, getSettings } from "@/lib/db/index.js";
import { ComboWriteError, createComboWrite } from "@/lib/combos/comboWrites.js";
import { fail, ok, requireManagementAuth } from "../_lib/http.js";

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

/** GET /api/mgmt/v1/combos */
export async function GET(request) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    const [combos, settings] = await Promise.all([getCombos(), getSettings()]);
    const strategies = settings?.comboStrategies || {};
    return ok({
      combos: combos
        .filter((combo) => !combo.kind || combo.kind === "llm")
        .map((combo) => toComboData(combo, strategies)),
    });
  } catch {
    return fail(500, "Failed to fetch combos");
  }
}

/** POST /api/mgmt/v1/combos */
export async function POST(request) {
  const denied = await requireManagementAuth(request);
  if (denied) return denied;
  try {
    const combo = await createComboWrite(await request.json());
    return ok(combo, { status: 201 });
  } catch (error) {
    if (error instanceof ComboWriteError) {
      return fail(error.status || 400, error.message);
    }
    return fail(500, "Failed to create combo");
  }
}
