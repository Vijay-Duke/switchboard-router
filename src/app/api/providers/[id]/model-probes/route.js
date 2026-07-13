// @ts-check
import { NextResponse } from "next/server";
import { getProviderConnectionById, getProbesForScope } from "@/lib/db/index.js";
import { buildModelProbeScopeKey } from "@/lib/model-probe/index.js";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    const scopeKey = buildModelProbeScopeKey(connection);
    const probes = await getProbesForScope(connection.provider, scopeKey);
    return NextResponse.json({ probes }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error listing model probes:", error);
    return NextResponse.json({ error: "Failed to list probes" }, { status: 500 });
  }
}
