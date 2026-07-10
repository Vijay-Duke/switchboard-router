export const LOCALES = [
  "en",
  "zh-CN",
];
export const DEFAULT_LOCALE = "en";
export const LOCALE_COOKIE = "locale";

export const LOCALE_NAMES = {
  en: "English",
  vi: "Tiếng Việt",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  "pt-BR": "Português (Brasil)",
  "pt-PT": "Português (Portugal)",
  ko: "한국어",
  es: "Español",
  de: "Deutsch",
  fr: "Français",
  he: "עברית",
  ar: "العربية",
  ru: "Русский",
  pl: "Polski",
  cs: "Čeština",
  nl: "Nederlands",
  tr: "Türkçe",
  uk: "Українська",
  tl: "Tagalog",
  id: "Indonesia",
  th: "ไทย",
  hi: "हिन्दी",
  bn: "বাংলা",
  ur: "اردو",
  ro: "Română",
  sv: "Svenska",
  it: "Italiano",
  el: "Ελληνικά",
  hu: "Magyar",
  fi: "Suomi",
  da: "Dansk",
  no: "Norsk",
  fa: "فارسی",
};

export function normalizeLocale(locale) {
  const normalized = locale === "zh" ? "zh-CN" : locale;
  return LOCALES.includes(normalized) ? normalized : DEFAULT_LOCALE;
}

export function isSupportedLocale(locale) {
  return LOCALES.includes(locale);
}
