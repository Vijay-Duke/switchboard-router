// URL compatibility for the 2026-07 docs consolidation.
//
// `output: "export"` has no server, so next.config `redirects()` is ignored.
// Every retired slug is still built, as a page that meta-refreshes to its
// replacement. Same for the four locales whose translations were removed:
// they now point at the English article instead of silently rendering it
// under a locale prefix that implies a translation exists.

export const SLUG_REDIRECTS = {
  "integration/claude-code": "clients/cli-tools",
  "integration/cline": "clients/cli-tools",
  "integration/codex": "clients/cli-tools",
  "integration/continue": "clients/cli-tools",
  "integration/cursor": "clients/cli-tools",
  "integration/roo": "clients/cli-tools",
  "integration/other-tools": "clients/openai-compatible",
  "features/combos": "using/combos",
  "features/smart-routing": "using/combos",
  "features/quota-tracking": "using/usage",
  "providers/cheap": "using/providers",
  "providers/free": "using/providers",
  "providers/subscription": "using/providers",
  "deployment/cloud": "deployment/docker",
  "deployment/localhost": "deployment/local",
};

// Locales that used to have translated content and now redirect to English.
export const RETIRED_LANG_CODES = ["vi", "zh-CN", "es", "ja"];

export const RETIRED_SLUGS = Object.keys(SLUG_REDIRECTS);

/**
 * Where a (lang, slug) pair should send the reader, or null when it is canonical.
 * @param {string} lang
 * @param {string[]|string} slug
 * @returns {string|null} absolute path (no basePath)
 */
export function redirectTarget(lang, slug = []) {
  const slugPath = Array.isArray(slug) ? slug.join("/") : slug;
  const mapped = SLUG_REDIRECTS[slugPath];
  const retiredLang = RETIRED_LANG_CODES.includes(lang);
  if (!mapped && !retiredLang) return null;
  const target = mapped || slugPath;
  return target ? `/en/${target}/` : "/en/";
}
