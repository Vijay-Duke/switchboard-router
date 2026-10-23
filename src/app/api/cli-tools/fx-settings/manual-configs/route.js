// @ts-check
import { NextResponse } from "next/server";
import {
  buildFxManualConfigFiles,
  isNonEmptyString,
  isOptionalString,
  normalizeModelIds,
  resolveDefaultModel,
} from "@/lib/cli/modelCatalog.js";
import { buildPiCapsResolver, normalizeBaseUrl } from "@/lib/cli/piCatalogSync.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const baseUrl = body?.baseUrl;
  const apiKey = body?.apiKey;
  const models = normalizeModelIds(body?.models);
  const defaultModel = body?.defaultModel;

  if (!isNonEmptyString(baseUrl) || !isOptionalString(apiKey) || models.length === 0) {
    return NextResponse.json({ error: "baseUrl, models, and API key are invalid" }, { status: 400 });
  }

  const normalized = normalizeBaseUrl(baseUrl);
  const key = apiKey || "sk_switchboard";
  const capsResolver = await buildPiCapsResolver();

  const configs = buildFxManualConfigFiles({
    baseUrl: normalized,
    apiKey: key,
    models,
    defaultModel: resolveDefaultModel(defaultModel, models),
    capsResolver,
  });

  return NextResponse.json({ configs });
}
