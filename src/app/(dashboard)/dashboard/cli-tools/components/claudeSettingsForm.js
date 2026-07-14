// @ts-check

/**
 * Read the Claude model fields exactly as they exist in settings.json.
 * Catalog defaults are suggestions for Apply, not evidence of current config.
 *
 * @param {Array<{ alias: string, envKey?: string }>} models
 * @param {Record<string, any> | null | undefined} settings
 * @returns {Record<string, string>}
 */
export function readClaudeModelMappings(models, settings) {
  const env = settings?.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env
    : {};
  return Object.fromEntries(models.map((model) => [
    model.alias,
    model.envKey && typeof env[model.envKey] === "string" ? env[model.envKey] : "",
  ]));
}
