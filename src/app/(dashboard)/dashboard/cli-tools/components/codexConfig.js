// @ts-check
const parseTomlString = (line, key) => {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(["'])([^\\n]*?)\\1\\s*(?:#.*)?$`));
  return match ? match[2] : "";
};

/**
 * Read base_url and the bearer key from one [model_providers.<id>] table (plus its
 * http_headers sub-table), so other providers cannot affect the form. Defaults to
 * the active root `model_provider`; pass `providerId` to read a specific table.
 * @param {unknown} config
 * @param {string} [providerId]
 */
export function getCurrentCodexProviderSettings(config, providerId) {
  if (typeof config !== "string") return { baseUrl: "", apiKey: "" };

  const lines = config.split(/\r?\n/);
  let modelProvider = providerId || "";
  let inRootTable = true;

  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inRootTable = false;
      continue;
    }
    if (inRootTable && !providerId) {
      modelProvider = parseTomlString(line, "model_provider") || modelProvider;
    }
  }

  if (!modelProvider) return { baseUrl: "", apiKey: "" };

  const activeTable = `model_providers.${modelProvider}`;
  let inActiveProviderTable = false;
  let inActiveHeadersTable = false;
  let baseUrl = "";
  let apiKey = "";

  for (const line of lines) {
    const tableMatch = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/);
    if (tableMatch) {
      inActiveProviderTable = tableMatch[1] === activeTable;
      inActiveHeadersTable = tableMatch[1] === `${activeTable}.http_headers`;
      continue;
    }
    if (inActiveProviderTable) {
      baseUrl = parseTomlString(line, "base_url") || baseUrl;
    }
    if (inActiveHeadersTable) {
      const authorization = parseTomlString(line, "Authorization");
      const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
      apiKey = bearerMatch ? bearerMatch[1] : apiKey;
    }
  }

  return { baseUrl, apiKey };
}

export function getCurrentCodexProviderBaseUrl(config) {
  return getCurrentCodexProviderSettings(config).baseUrl;
}

// ── Codex CLI profiles (`codex -p <name>` → ~/.codex/<name>.config.toml) ──

/** @param {unknown} name */
export function isValidCodexProfileName(name) {
  return typeof name === "string"
    && /^[a-z0-9_-]+$/.test(name)
    && name.length <= 64
    && name !== "config";
}

/** @param {unknown} model */
export function isValidCodexProfileModel(model) {
  return typeof model === "string"
    && model.trim().length > 0
    && model.length <= 256
    && !/[\r\n"\\]/.test(model);
}

/**
 * Suggest a profile name from a model id's provider prefix (or the bare id),
 * suffixing -2, -3… to avoid existing names.
 * @param {unknown} modelId
 * @param {string[]} [existingNames]
 */
export function deriveProfileNameFromModel(modelId, existingNames = []) {
  if (!modelId || typeof modelId !== "string") return "model";
  const trimmed = modelId.trim();
  const source = trimmed.includes("/") ? trimmed.split("/")[0] : trimmed;
  let base = source.toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[-_]+|[-_]+$/g, "") || "model";
  if (base === "config") base = "model-config";
  base = base.slice(0, 60);

  let candidate = base;
  let counter = 2;
  while (existingNames.includes(candidate)) {
    candidate = `${base}-${counter}`;
    counter++;
  }
  return candidate;
}

/** @param {{ name: string, model: string }} profile */
export function buildCodexProfileToml({ name, model }) {
  return `# codex -p ${name}\nmodel = "${model}"\nmodel_provider = "switchboard"\n`;
}

/** @param {unknown} content */
export function parseCodexProfileModel(content) {
  if (typeof content !== "string") return "";
  const match = content.match(/^\s*model\s*=\s*(["'])([^"'\n]+)\1/m);
  return match ? match[2] : "";
}
