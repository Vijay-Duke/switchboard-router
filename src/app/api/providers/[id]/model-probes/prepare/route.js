// @ts-check
import { NextResponse } from "next/server";
import { getProviderConnectionById, getProbesForScope } from "@/lib/db/index.js";
import {
  MODEL_PROBE_CAPS,
  buildModelProbeScopeKey,
  clampProbeOptions,
  prepareProbeModels,
} from "@/lib/model-probe/index.js";
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
    const scopeKey = buildModelProbeScopeKey(connection);
    const probes = await getProbesForScope(connection.provider, scopeKey);
    const prepared = prepareProbeModels({
      models: body.models || [],
      probes,
      providerAlias,
      skipFreshOk: body.skipFreshOk === true,
      freshOkMs: body.freshOkMs,
    });

    return NextResponse.json({
      provider: connection.provider,
      connectionId: connection.id,
      scopeKey,
      providerAlias,
      caps: MODEL_PROBE_CAPS,
      requested: clampProbeOptions(body),
      ...prepared,
    });
  } catch (error) {
    console.log("Error preparing model probes:", error);
    return NextResponse.json({ error: "Failed to prepare model probes" }, { status: 500 });
  }
}
