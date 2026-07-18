// @ts-check

/** Short, picker-friendly provider tags — keeps kr/cr/llm distinct in Claude /model. */
const SOURCE_TAGS = Object.freeze({
  "lite-llm": "llm",
  litellm: "llm",
});

const FAMILY_TOKENS = [
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "gemini",
  "gpt",
  "glm",
  "deepseek",
  "composer",
  "kimi",
  "qwen",
];

const REGION_RULES = [
  { pattern: /ap-southeast|low-carbon-apac|\bapac\b/i, tag: "apac" },
  { pattern: /eu-west|europe|\beu\b/i, tag: "eu" },
  { pattern: /us-east|us-west|\bus\b/i, tag: "us" },
];

const INFRA_TOKENS = ["bedrock", "vertex", "azure", "openai"];

/**
 * @param {string} value
 */
function sanitizeSegment(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

/**
 * @param {string} prefix
 */
function sourceTag(prefix) {
  const normalized = sanitizeSegment(prefix);
  return SOURCE_TAGS[normalized] || normalized.slice(0, 10);
}

/**
 * @param {string | null | undefined} raw
 */
function formatFamilyVersion(raw) {
  if (!raw) return null;
  return raw.replace(/[._-]/g, ".");
}

/**
 * @param {string[]} pathParts
 */
function extractModelTokens(pathParts) {
  const joined = pathParts.join("/").toLowerCase();
  const family = FAMILY_TOKENS.find((token) => joined.includes(token)) || null;
  const region = REGION_RULES.find((rule) => rule.pattern.test(joined))?.tag || null;
  const infra = INFRA_TOKENS.find((token) => joined.includes(token)) || null;
  const variant = joined.match(/\b(\d+m)\b/i)?.[1]?.toLowerCase() || null;
  const familyVersionRaw = family
    ? joined.match(new RegExp(`${family}[-._]?(\\d+(?:[._-]\\d+)*)`, "i"))?.[1]
    : null;
  const version = formatFamilyVersion(familyVersionRaw);
  return { family, region, infra, variant, version };
}

/**
 * Derive a short Claude /model picker label from a Switchboard model ID.
 * Routing still uses the full model ID — only the visible label is shortened.
 *
 * @param {string} modelId
 */
export function formatClaudeCatalogDisplayLabel(modelId) {
  const trimmed = String(modelId || "").trim();
  if (!trimmed) return "";

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 0) {
    return trimmed;
  }

  const source = sourceTag(trimmed.slice(0, slashIndex));
  const pathParts = trimmed.slice(slashIndex + 1).split("/").filter(Boolean);
  const tokens = extractModelTokens(pathParts);

  /** @type {string[]} */
  const parts = [source];
  if (tokens.region) parts.push(tokens.region);
  if (tokens.infra) parts.push(tokens.infra);

  if (tokens.family) {
    const familyLabel = tokens.variant
      ? `${tokens.family} ${tokens.variant}`
      : tokens.version
        ? `${tokens.family} ${tokens.version}`
        : tokens.family;
    parts.push(familyLabel);
  } else if (pathParts.length > 0) {
    const tail = pathParts[pathParts.length - 1]
      .replace(/^anthropic\./i, "")
      .replace(/[._]/g, " ")
      .trim();
    if (tail) parts.push(tail.slice(0, 24));
  }

  return parts.join(" · ");
}

/**
 * @param {string} modelId
 * @param {number} index
 */
function disambiguationSuffix(modelId, index) {
  const parts = String(modelId || "").split("/").filter(Boolean);
  if (parts.length >= 3) {
    return parts[1].replace(/[._-]/g, " ").trim().slice(0, 20);
  }
  if (parts.length === 2) {
    return parts[1].replace(/^anthropic\./i, "").replace(/[._-]/g, " ").trim().slice(0, 20);
  }
  const tail = parts[parts.length - 1] || `model-${index + 1}`;
  return tail
    .replace(/^anthropic\./i, "")
    .replace(/[._-]/g, " ")
    .trim()
    .slice(0, 20) || String(index + 1);
}

/**
 * Build unique picker labels for a catalog selection. New models get labels
 * automatically — no alias maintenance required.
 *
 * @param {string[]} modelIds
 * @returns {Map<string, string>}
 */
export function buildClaudeCatalogDisplayNameMap(modelIds) {
  const normalized = modelIds
    .map((modelId) => String(modelId || "").trim())
    .filter(Boolean);
  const baseLabels = normalized.map((modelId) => ({
    modelId,
    base: formatClaudeCatalogDisplayLabel(modelId),
  }));

  /** @type {Map<string, string[]>} */
  const grouped = new Map();
  for (const entry of baseLabels) {
    const bucket = grouped.get(entry.base) || [];
    bucket.push(entry.modelId);
    grouped.set(entry.base, bucket);
  }

  /** @type {Map<string, string>} */
  const labels = new Map();
  for (const [base, ids] of grouped.entries()) {
    if (ids.length === 1) {
      labels.set(ids[0], base);
      continue;
    }
    const used = new Set();
    ids.forEach((modelId, index) => {
      let candidate = `${base} · ${disambiguationSuffix(modelId, index)}`;
      let suffix = 2;
      while (used.has(candidate)) {
        const tail = modelId.split("/").filter(Boolean).pop() || `alt-${suffix}`;
        candidate = `${base} · ${tail.replace(/^anthropic\./i, "").replace(/[._-]/g, " ").trim().slice(0, 20)}`;
        if (used.has(candidate)) {
          candidate = `${base} · ${index + 1}`;
        }
        suffix += 1;
      }
      used.add(candidate);
      labels.set(modelId, candidate);
    });
  }
  return labels;
}

/**
 * @param {string} modelId
 * @param {Map<string, string>} [labelMap]
 */
export function formatClaudeCatalogDisplayName(modelId, labelMap) {
  const trimmed = String(modelId || "").trim();
  if (!trimmed) return "";
  const label = labelMap?.get(trimmed) || formatClaudeCatalogDisplayLabel(trimmed);
  return label;
}

/**
 * @param {unknown} entries
 * @returns {Array<{value: string, label: string, labelCustom: boolean}>}
 */
export function assignClaudeCatalogDisplayRows(entries) {
  const normalized = (Array.isArray(entries) ? entries : []).map((entry) => {
    if (typeof entry === "string") {
      return { value: entry.trim(), label: "", labelCustom: false };
    }
    const value = String(entry?.value || "").trim();
    const label = String(entry?.label || "").trim();
    return {
      value,
      label,
      labelCustom: Boolean(entry?.labelCustom) || Boolean(label),
    };
  }).filter((entry) => entry.value);

  const disambiguated = buildClaudeCatalogDisplayNameMap(normalized.map((entry) => entry.value));
  return normalized.map((entry) => ({
    value: entry.value,
    labelCustom: entry.labelCustom,
    label: entry.labelCustom && entry.label
      ? entry.label
      : (disambiguated.get(entry.value) || formatClaudeCatalogDisplayLabel(entry.value)),
  }));
}

/**
 * @param {Array<{value: string, label?: string, labelCustom?: boolean}>} entries
 * @returns {Record<string, string>}
 */
export function buildClaudeCatalogPickerLabelsPayload(entries) {
  return Object.fromEntries(
    assignClaudeCatalogDisplayRows(entries).map((entry) => [entry.value, entry.label]),
  );
}
