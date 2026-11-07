// @ts-check
import { buildModelsList } from "../route.js";
import { corsPreflightResponse } from "@/shared/utils/cors.js";

// URL slug → service kind(s). `llm` is the default chat kind (same list as
// GET /v1/models); `web` covers both webSearch and webFetch.
const KIND_SLUG_MAP = {
  "llm": ["llm"],
  "image": ["image"],
  "tts": ["tts"],
  "stt": ["stt"],
  "embedding": ["embedding"],
  "image-to-text": ["imageToText"],
  "web": ["webSearch", "webFetch"],
};

const LLM_KIND = "llm";

export async function OPTIONS(request) {
  return corsPreflightResponse(request, { methods: "GET, OPTIONS" });
}

/**
 * GET /v1/models/{kind}              - OpenAI-compatible models list filtered by capability.
 * GET /v1/models/{provider}/{model}  - OpenAI-compatible single model lookup.
 * Supported kinds: llm, image, tts, stt, embedding, image-to-text, web.
 *
 * A catch-all segment is required because provider-prefixed model ids
 * contain a slash (e.g. cc/claude-sonnet-5).
 */
export async function GET(request, { params }) {
  try {
    const resolved = await params;
    const raw = resolved?.model ?? resolved?.kind;
    const path = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(String);
    const identifier = path.join("/");
    const kindFilter = path.length === 1 ? KIND_SLUG_MAP[identifier] : null;

    if (kindFilter) {
      const data = await buildModelsList(kindFilter, { signal: request?.signal });
      return Response.json({ object: "list", data });
    }

    // A single unknown segment without a slash is neither a kind nor a
    // provider-prefixed id; keep the stable "unknown kind" 404.
    if (path.length <= 1 && !identifier.includes("/")) {
      return Response.json(
        {
          error: {
            message: `Unknown model kind: ${identifier}. Supported: ${Object.keys(KIND_SLUG_MAP).join(", ")}`,
            type: "invalid_request_error",
          },
        },
        { status: 404 }
      );
    }

    // Match the same LLM catalog exposed by GET /v1/models.
    const models = await buildModelsList([LLM_KIND], { signal: request?.signal });
    const matchedModel = models.find((candidate) => candidate.id === identifier);
    if (!matchedModel) {
      return Response.json(
        {
          error: {
            message: `The model '${identifier}' does not exist or you do not have access to it.`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        { status: 404 }
      );
    }
    return Response.json(matchedModel);
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: "Failed to fetch models", type: "server_error" } },
      { status: 500 }
    );
  }
}
