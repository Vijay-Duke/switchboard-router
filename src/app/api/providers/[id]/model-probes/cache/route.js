// @ts-check
import { NextResponse } from "next/server";
import { clearProbes, getProviderConnectionById } from "@/lib/db/index.js";
import { buildModelProbeScopeKey } from "@/lib/model-probe/index.js";

export const dynamic = "force-dynamic";

export async function DELETE(_request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const scopeKey = buildModelProbeScopeKey(connection);
    const cleared = await clearProbes(connection.provider, scopeKey);
    return NextResponse.json({
      success: true,
      provider: connection.provider,
      connectionId: connection.id,
      scopeKey,
      cleared,
    });
  } catch (error) {
    console.log("Error clearing model probe cache:", error);
    return NextResponse.json({ error: "Failed to clear model probe cache" }, { status: 500 });
  }
}
