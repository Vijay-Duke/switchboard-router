export const DEFAULT_LANG = "en";

// Only locales with translated content under content/<code>/ belong here — an
// entry without content renders English under a translated URL, which reads as
// a broken localization. Retired locales redirect (see constants/redirects.js).
export const LANGUAGES = [
  { code: "en", name: "English", native: "English", flag: "🇺🇸" }
];

export const LANG_CODES = LANGUAGES.map(l => l.code);

export function isValidLang(code) {
  return LANG_CODES.includes(code);
}

export function getLanguage(code) {
  return LANGUAGES.find(l => l.code === code) || LANGUAGES[0];
}
