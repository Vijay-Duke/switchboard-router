// @ts-check
/**
 * Shared helpers for "Import models" from a connection's live /models listing.
 */

/**
 * Guess service kind from a model id/name when the upstream list has no type.
 * @param {string} id
 * @param {object} [model]
 * @returns {string}
 */
export function inferModelType(id, model = {}) {
  const explicit = model.kind || model.type;
  if (explicit && typeof explicit === "string") {
    const t = explicit.toLowerCase();
    if (t === "chat" || t === "text" || t === "language") return "llm";
    return t;
  }
  const s = String(id || "").toLowerCase();
  if (/embed/.test(s)) return "embedding";
  if (/(^|[-_/])(tts|speech)([-_/]|$)/.test(s)) return "tts";
  if (/(whisper|transcri|speech-to-text|(^|[-_/])stt([-_/]|$))/.test(s)) return "stt";
  if (/(imagine-video|video-gen|(^|[-_/])video([-_/]|$))/.test(s) && !/revision/.test(s)) {
    return "video";
  }
  // Image gen (not vision/multimodal chat)
  if (
    /(imagine-image|dall-e|stable-diffusion|sdxl|flux|midjourney|image-gen)/.test(s) ||
    (/(^|[-_/])image([-_/]|$)/.test(s) && !/(vision|vl|multimodal)/.test(s))
  ) {
    return "image";
  }
  return "llm";
}

/**
 * Strip vendor/provider prefixes so we store bare model ids.
 * @param {string} modelId
 * @param {string} [providerAlias]
 * @returns {string}
 */
export function cleanImportedModelId(modelId, providerAlias) {
  let id = String(modelId || "").trim();
  if (!id) return "";
  // Drop leading "models/" (Gemini style)
  id = id.replace(/^models\//, "");
  if (providerAlias) {
    const prefix = `${providerAlias}/`;
    if (id.startsWith(prefix)) id = id.slice(prefix.length);
  }
  // Common vendor prefixes
  id = id.replace(/^(openai|anthropic|google|x-ai|xai|meta-llama|mistralai)\//i, "");
  return id.trim();
}

/**
 * Normalize a raw models API entry into { id, name, type }.
 * @param {any} model
 * @param {string} [providerAlias]
 * @returns {{ id: string, name: string, type: string }|null}
 */
export function normalizeImportedModel(model, providerAlias) {
  if (model == null) return null;
  if (typeof model === "string") {
    const id = cleanImportedModelId(model, providerAlias);
    if (!id) return null;
    return { id, name: id, type: inferModelType(id) };
  }
  const rawId = model.id || model.name || model.model || model.slug;
  if (!rawId) return null;
  const id = cleanImportedModelId(rawId, providerAlias);
  if (!id) return null;
  const name =
    model.display_name ||
    model.displayName ||
    model.name ||
    model.title ||
    id;
  return { id, name: String(name), type: inferModelType(id, model) };
}
