// @ts-check
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getModelKind } from "@/shared/constants/models";
import { buildModelsList } from "../route.js";
import { corsPreflightResponse } from "@/shared/utils/cors.js";

const KIND_ENDPOINT = {
  llm: "/v1/chat/completions",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
  embedding: "/v1/embeddings",
  imageToText: "/v1/chat/completions",
  webSearch: "/v1/search",
  webFetch: "/v1/web/fetch",
};

const TTS_VOICES_API = new Set(["elevenlabs", "edge-tts", "deepgram", "inworld", "local-device"]);

function buildInfo({ alias, providerId, model, kind, providerInfo }) {
  const out = {
    id: `${alias}/${model.id}`,
    name: model.name || model.id,
    kind,
    owned_by: alias,
    endpoint: KIND_ENDPOINT[kind] || null,
  };
  if (model.params) out.params = model.params;
  if (model.capabilities) out.capabilities = model.capabilities;
  if (model.options) out.options = model.options;
  if (model.dimensions) out.dimensions = model.dimensions;
  if (model.contextWindow) out.contextWindow = model.contextWindow;
  if (kind === "tts" && TTS_VOICES_API.has(providerId)) {
    out.voicesUrl = `/v1/audio/voices?provider=${providerId}`;
  }
  if (kind === "webSearch" && providerInfo?.searchConfig) {
    const cfg = providerInfo.searchConfig;
    if (cfg.searchTypes) out.searchTypes = cfg.searchTypes;
    if (cfg.maxMaxResults) out.maxResults = cfg.maxMaxResults;
    if (cfg.requiredOptions) out.required = cfg.requiredOptions;
  }
  return out;
}

// id format: "{alias}/{modelId}" - alias may also be providerId
// requestedKind: optional, disambiguates duplicate ids across kinds (e.g. gemini-2.5-pro llm vs stt)
function lookup(fullId, requestedKind) {
  if (!fullId || !fullId.includes("/")) return null;
  const slash = fullId.indexOf("/");
  const alias = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const providerId = ALIAS_TO_ID[alias] || alias;
  const providerInfo = AI_PROVIDERS[providerId];

  // PROVIDER_MODELS lookup (by alias key, fallback to providerId)
  const list = PROVIDER_MODELS[alias] || PROVIDER_MODELS[providerId] || [];
  const m = requestedKind
    ? list.find((x) => x.id === modelId && getModelKind(x, "llm") === requestedKind)
    : list.find((x) => x.id === modelId);
  if (m) {
    const kind = getModelKind(m, "llm");
    return buildInfo({ alias, providerId, model: m, kind, providerInfo });
  }

  // Web search/fetch — virtual model id "search" / "fetch"
  if (modelId === "search" && providerInfo?.searchConfig) {
    return buildInfo({
      alias, providerId, kind: "webSearch", providerInfo,
      model: { id: "search", name: `${providerInfo.name} Search`, params: ["query", "max_results", "country", "language", "time_range", "domain_filter", "search_type"] },
    });
  }
  if (modelId === "fetch" && providerInfo?.fetchConfig) {
    return buildInfo({
      alias, providerId, kind: "webFetch", providerInfo,
      model: { id: "fetch", name: `${providerInfo.name} Fetch`, params: ["url", "format", "max_characters"] },
    });
  }
  return null;
}

// All service kinds — used when no (or no valid) ?kind= disambiguator is given.
const ALL_KINDS = ["llm", "image", "tts", "stt", "embedding", "imageToText", "webSearch", "webFetch"];

/**
 * Resolve metadata for a model that GET /v1/models advertises but the static
 * PROVIDER_MODELS catalog does not know: provider-node prefixed models
 * (e.g. "qa-openai/qa-chat"), compatible-provider discovered models, custom
 * models, combos, and aliases (QA-024). Metadata must agree with what the
 * list endpoint actually serves, so the list builder is the source of truth.
 */
async function lookupAdvertised(fullId, requestedKind, signal) {
  let advertised = [];
  try {
    advertised = await buildModelsList(
      requestedKind && ALL_KINDS.includes(requestedKind) ? [requestedKind] : ALL_KINDS,
      { signal },
    );
  } catch {
    return null;
  }
  const entry = advertised.find((m) => m?.id === fullId);
  if (!entry) return null;

  const kind = entry.kind || "llm";
  const slash = entry.id.indexOf("/");
  const modelId = slash === -1 ? entry.id : entry.id.slice(slash + 1);
  const out = {
    id: entry.id,
    name: entry.name || entry.display_name || modelId,
    kind,
    owned_by: entry.owned_by || (slash === -1 ? "switchboard" : entry.id.slice(0, slash)),
    endpoint: KIND_ENDPOINT[kind] || null,
  };
  if (entry.capabilities) out.capabilities = entry.capabilities;
  return out;
}

export async function OPTIONS(request) {
  return corsPreflightResponse(request, { methods: "GET, OPTIONS" });
}

// GET /v1/models/info?id={alias}/{modelId} — metadata for a single model
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const kind = searchParams.get("kind");
  if (!id) {
    return Response.json(
      { error: { message: "Missing required query param: id (e.g. ?id=openai/dall-e-3)", type: "invalid_request_error" } },
      { status: 400 },
    );
  }
  const info = lookup(id, kind) || await lookupAdvertised(id, kind, request?.signal);
  if (!info) {
    return Response.json(
      { error: { message: `Model not found: ${id}`, type: "not_found" } },
      { status: 404 },
    );
  }
  return Response.json(info);
}
