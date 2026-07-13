// @ts-check
import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/db/index.js";
import { buildModelProbeScopeKey } from "@/lib/model-probe/index.js";
import { startVerify } from "@/lib/model-probe/verifyJob.js";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    const body = await request.json().catch(() => ({}));
    const providerAlias = body.providerAlias || PROVIDER_ID_TO_ALIAS[connection.provider] || connection.provider;
    const scopeKey = buildModelProbeScopeKey(connection);
    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
    const snapshot = await startVerify({
      connectionId: connection.id,
      scopeKey,
      providerId: connection.provider,
      providerAlias,
      models: body.models || [],
      opts: { concurrency: body.concurrency, batchSize: body.batchSize, timeoutMs: body.timeoutMs },
      baseUrl,
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    console.log("Error starting verify job:", error);
    return NextResponse.json({ error: "Failed to start verify" }, { status: 500 });
  }
}
