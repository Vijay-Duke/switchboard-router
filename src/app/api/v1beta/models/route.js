// @ts-check
import { PROVIDER_MODELS } from "@/shared/constants/models";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { corsPreflightResponse } from "@/shared/utils/cors.js";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import {
  buildCanonicalDisabledModelSet,
  isCanonicalModelDisabled,
} from "@/shared/utils/providerCustomModels.js";

// Gemini generateContent serves chat models — same filter as GET /v1/models.
const LLM_KIND = "llm";

/**
 * Handle CORS preflight — reflect the requesting Origin (gateway serves
 * browser clients on arbitrary origins; QA-023).
 */
export async function OPTIONS(request) {
  return corsPreflightResponse(request, { methods: "GET, OPTIONS" });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 * Returns models in Gemini API format
 */
export async function GET(request) {
  try {
    const models = [];
    const seen = new Set();

    function addModel({ name, displayName, description, methods = ["generateContent"] }) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: 128000,
        outputTokenLimit: 8192,
      });
    }

    // Skip models disabled in the dashboard so discovery matches what
    // generateContent actually serves (same helpers as GET /v1/models).
    let disabledByAlias = {};
    try {
      disabledByAlias = await getDisabledModels();
    } catch {
      disabledByAlias = {};
    }
    const isDisabled = (alias, modelId) => {
      const ids = disabledByAlias?.[alias];
      if (!ids) return false;
      return isCanonicalModelDisabled(buildCanonicalDisabledModelSet(ids, alias), modelId, alias);
    };

    for (const [provider, providerModels] of Object.entries(PROVIDER_MODELS)) {
      for (const model of providerModels) {
        if (isDisabled(provider, model.id)) continue;
        addModel({
          name: `models/${provider}/${model.id}`,
          displayName: model.name || model.id,
          description: `${provider} model: ${model.name || model.id}`,
        });

        if (provider === "gemini") {
          addModel({
            name: `models/${model.id}`,
            displayName: model.name || model.id,
            description: `Gemini model: ${model.name || model.id}`,
            methods: ["generateContent", "streamGenerateContent"],
          });
        }
      }
    }

    // Active advertised models — local/provider-node connections, custom
    // models, combos — so discovery lists everything generateContent actually
    // serves (QA-026). Static catalog names dedupe against these via `seen`.
    try {
      const advertised = await buildModelsList([LLM_KIND], { signal: request?.signal });
      for (const model of advertised) {
        if (!model?.id) continue;
        const displayName = model.display_name || model.name || model.id.split("/").pop();
        const owner = model.owned_by || model.id.split("/")[0];
        addModel({
          name: `models/${model.id}`,
          displayName,
          description: `${owner} model: ${displayName}`,
        });
      }
    } catch (e) {
      console.log("Could not fetch advertised models for Gemini discovery:", e?.message || e);
    }

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: "Failed to fetch models", code: 500 } }, { status: 500 });
  }
}
