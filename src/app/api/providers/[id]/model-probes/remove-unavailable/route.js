// @ts-check
import { NextResponse } from "next/server";
import {
  deleteCustomModel,
  getCustomModels,
  getModelIdsByStatus,
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
    const status = body.status || "dead";
    if (!["dead", "retryable"].includes(status)) {
      return NextResponse.json({ error: "Status must be dead or retryable" }, { status: 400 });
    }
    const scopeKey = buildModelProbeScopeKey(connection);
    const excludeFailureClasses = status === "retryable" ? ["auth"] : [];
    const unavailable = new Set(await getModelIdsByStatus(
      connection.provider,
      scopeKey,
      status,
      kind,
      { excludeFailureClasses },
    ));
    const customModels = await getCustomModels();
    const removableModels = customModels.filter((model) => {
      const modelKind = model.kind || model.type || "llm";
      if (model.providerAlias !== providerAlias || modelKind !== kind) return false;
      const canonicalId = canonicalModelId(model.id, providerAlias);
      return unavailable.has(canonicalId);
    });
    const removedModels = await Promise.all(removableModels.map(async (model) => {
      const modelKind = model.kind || model.type || "llm";
      await deleteCustomModel({ providerAlias, id: model.id, type: modelKind });
      return { id: model.id, kind: modelKind, name: model.name || model.id };
    }));

    return NextResponse.json({
      success: true,
      provider: connection.provider,
      connectionId: connection.id,
      scopeKey,
      providerAlias,
      status,
      removed: removedModels.length,
      removedModels,
    });
  } catch (error) {
    console.log("Error removing unavailable models:", error);
    return NextResponse.json({ error: "Failed to remove unavailable models" }, { status: 500 });
  }
}
