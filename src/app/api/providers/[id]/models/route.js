// @ts-check
import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { discoverConnectionModels } from "@/lib/providerModelDiscovery";

/**
 * GET /api/providers/[id]/models - Get models list from provider
 */
export async function GET(request, { params }) {
  const { id } = await params;
  const connection = await getProviderConnectionById(id);
  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const urlObj = new URL(request.url);
  const forceRefresh = urlObj.searchParams.get("refresh") === "true" ||
    urlObj.searchParams.get("force") === "true" ||
    request.headers.get("cache-control")?.includes("no-cache");

  const result = await discoverConnectionModels(connection, { forceRefresh: Boolean(forceRefresh) });
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    provider: connection.provider,
    connectionId: connection.id,
    models: result.models,
    ...(result.warning ? { warning: result.warning } : {}),
  });
}
