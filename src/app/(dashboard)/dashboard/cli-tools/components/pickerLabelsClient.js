// @ts-check

const PICKER_LABEL_BATCH_SIZE = 40;

/**
 * Generate labels in bounded requests so large catalogs do not expose the
 * API's per-request limit to users.
 *
 * @param {{
 *   modelIds: string[],
 *   namingModel?: string,
 *   existingLabels?: Record<string, string>,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export async function requestPickerLabels({
  modelIds,
  namingModel = "",
  existingLabels = {},
  fetchImpl = globalThis.fetch,
}) {
  const labels = {};
  const contextLabels = { ...existingLabels };
  const sources = new Set();

  for (let index = 0; index < modelIds.length; index += PICKER_LABEL_BATCH_SIZE) {
    const batch = modelIds.slice(index, index + PICKER_LABEL_BATCH_SIZE);
    const response = await fetchImpl("/api/cli-tools/picker-labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelIds: batch,
        namingModel: namingModel.trim() || undefined,
        existingLabels: contextLabels,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to generate picker labels");
    const batchLabels = data.labels && typeof data.labels === "object" ? data.labels : {};
    Object.assign(labels, batchLabels);
    Object.assign(contextLabels, batchLabels);
    sources.add(data.source === "ai" ? "ai" : "heuristic");
  }

  return {
    labels,
    source: sources.has("ai") ? "ai" : "heuristic",
  };
}
