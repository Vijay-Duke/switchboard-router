// @ts-check
import { NextResponse } from "next/server";
import {
  deleteCustomModel,
  getCustomModels,
  getDeadModelIds,
  getProviderConnectionById,
} from "@/lib/db/index.js";
import { buildModelProbeScopeKey, canonicalModelId } from "@/lib/model-probe/index.js";
import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";

export const dynamic = "force-dynamic";

function providerAliasFor(connection, requestedAlias) {
  return requestedAlias || PROVIDER_ID_TO_ALIAS[connection.provider] || connection.provider;
}

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const providerAlias = providerAliasFor(connection, body.providerAlias);
    const kind = body.kind || "llm";
    const scopeKey = buildModelProbeScopeKey(connection);
    const dead = new Set(await getDeadModelIds(connection.provider, scopeKey, kind));
    const customModels = await getCustomModels();
    const removedModels = [];

    for (const model of customModels) {
      const modelKind = model.kind || model.type || "llm";
      if (model.providerAlias !== providerAlias || modelKind !== kind) continue;
      const canonicalId = canonicalModelId(model.id, providerAlias);
      if (!dead.has(canonicalId)) continue;
      await deleteCustomModel({ providerAlias, id: model.id, type: modelKind });
      removedModels.push({ id: model.id, kind: modelKind, name: model.name || model.id });
    }

    return NextResponse.json({
      success: true,
      provider: connection.provider,
      connectionId: connection.id,
      scopeKey,
      providerAlias,
      removed: removedModels.length,
      removedModels,
    });
  } catch (error) {
    console.log("Error removing unavailable models:", error);
    return NextResponse.json({ error: "Failed to remove unavailable models" }, { status: 500 });
  }
}
