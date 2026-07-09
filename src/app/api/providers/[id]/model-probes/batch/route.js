// @ts-check
import { NextResponse } from "next/server";
import { getProviderConnectionById, upsertProbeResult } from "@/lib/db/index.js";
import {
  buildModelProbeScopeKey,
  clampProbeOptions,
  runBatch,
} from "@/lib/model-probe/index.js";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";

export const dynamic = "force-dynamic";

function countByStatus(results, status) {
  return results.filter((result) => result.probeStatus === status).length;
}

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
    const options = clampProbeOptions(body);
    const providerAlias = providerAliasFor(connection, body.providerAlias);
    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
    const scopeKey = buildModelProbeScopeKey(connection);
    const { results, caps } = await runBatch({
      models: body.models || [],
      providerAlias,
      concurrency: options.concurrency,
      batchSize: options.batchSize,
      timeoutMs: options.timeoutMs,
      warmup: body.warmup === true,
      baseUrl,
    });

    const authFailure = results.length > 0 && results.every((result) => result.failureClass === "auth");
    if (authFailure) {
      return NextResponse.json({
        provider: connection.provider,
        connectionId: connection.id,
        scopeKey,
        providerAlias,
        providerError: true,
        error: "Provider authentication failed for every probed model. Check this connection before retrying.",
        results,
        caps,
      }, { status: 401 });
    }

    for (const result of results) {
      await upsertProbeResult({
        providerId: connection.provider,
        scopeKey,
        modelId: result.canonicalId,
        kind: result.kind,
        status: result.probeStatus,
        latencyMs: result.latencyMs,
        failureClass: result.failureClass,
        failureMessage: result.failureMessage,
        checkedAt: result.checkedAt,
      });
    }

    return NextResponse.json({
      provider: connection.provider,
      connectionId: connection.id,
      scopeKey,
      providerAlias,
      results,
      summary: {
        total: results.length,
        ok: countByStatus(results, "ok"),
        dead: countByStatus(results, "dead"),
        retryable: countByStatus(results, "retryable"),
      },
      caps,
    });
  } catch (error) {
    console.log("Error running model probe batch:", error);
    return NextResponse.json({ error: "Failed to run model probe batch" }, { status: 500 });
  }
}
