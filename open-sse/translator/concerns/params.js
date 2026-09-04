// Concern: sampling-range validation for request translators.
//
// No translator previously clamped temperature/top_p/top_k to the target's
// accepted range, so out-of-range values 400'd upstream with no local error.
// paramSupport.js strips categorically-unsupported params but never clamps
// ranges — clampSampling fills that gap. Call it on the object that carries
// the target-native sampling fields at the end of each openai-to-* translator.

function clampNumber(value, min, max) {
  if (typeof value !== "number" || Number.isNaN(value)) return value;
  return Math.min(max, Math.max(min, value));
}

// Clamp known sampling keys in place; unknown keys pass through untouched.
// top_p/topP are 0–1 on every target we route. Temperature ceilings differ:
// Gemini/OpenAI-compatible 0–2 (default), Claude-backed targets (Anthropic,
// Kiro) 0–1 — pass `maxTemperature` per target. Ollama has no documented
// range, so its translator does not call this.
export function clampSampling(container, { maxTemperature = 2 } = {}) {
  if (!container || typeof container !== "object") return container;
  if (container.temperature !== undefined) {
    container.temperature = clampNumber(container.temperature, 0, maxTemperature);
  }
  for (const key of ["top_p", "topP"]) {
    if (container[key] !== undefined) {
      container[key] = clampNumber(container[key], 0, 1);
    }
  }
  for (const key of ["top_k", "topK"]) {
    if (container[key] !== undefined && typeof container[key] === "number" && !Number.isNaN(container[key])) {
      container[key] = Math.max(0, Math.floor(container[key]));
    }
  }
  return container;
}
