// @ts-check
import { NextResponse } from "next/server";
import {
  buildPiManualConfigFiles,
  isNonEmptyString,
  isOptionalString,
  normalizeModelIds,
  resolveDefaultModel,
} from "@/lib/cli/modelCatalog.js";
import { buildPiCapsResolver, normalizeBaseUrl } from "@/lib/cli/piCatalogSync.js";
import { normalizeClaudeCatalogPickerLabels } from "@/shared/claudeGateway.js";

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
  const requestedPickerLabels = body?.pickerLabels;

  const pickerLabelsValid = requestedPickerLabels == null
    || (
      typeof requestedPickerLabels === "object"
      && !Array.isArray(requestedPickerLabels)
      && Object.values(requestedPickerLabels).every((label) => typeof label === "string")
    );

  if (!isNonEmptyString(baseUrl)
    || !isOptionalString(apiKey)
    || models.length === 0
    || !pickerLabelsValid) {
    return NextResponse.json({ error: "baseUrl, models, API key, or picker labels are invalid" }, { status: 400 });
  }

  const normalized = normalizeBaseUrl(baseUrl);
  const key = apiKey || "sk_switchboard";
  const pickerLabels = normalizeClaudeCatalogPickerLabels(requestedPickerLabels, models);
  const capsResolver = await buildPiCapsResolver();

  const configs = buildPiManualConfigFiles({
    baseUrl: normalized,
    apiKey: key,
    models,
    defaultModel: resolveDefaultModel(defaultModel, models),
    pickerLabels,
    capsResolver,
  });

  return NextResponse.json({ configs });
}
