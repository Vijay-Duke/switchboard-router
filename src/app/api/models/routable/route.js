// @ts-check
import { buildModelsList } from "@/app/api/v1/models/route.js";

export const dynamic = "force-dynamic";

// GET /api/models/routable — dashboard-local mirror of the gateway's LLM model
// list (static catalogs + custom models + compatible discovery + live catalogs).
// /api/v1/models requires a client API key the dashboard browser doesn't hold,
// so client-side pickers read this auth-free server-side build instead.
export async function GET(request) {
  try {
    const models = await buildModelsList(["llm"], { signal: request?.signal });
    return Response.json({ data: models });
  } catch (error) {
    console.log("Error building routable models:", error);
    return Response.json({ error: "Failed to build models list" }, { status: 500 });
  }
}
