export const LOCALES = [
  "en",
  "zh-CN",
];
export const DEFAULT_LOCALE = "en";
export const LOCALE_COOKIE = "locale";

export const LOCALE_NAMES = {
  en: "English",
  "zh-CN": "简体中文",
};

export function normalizeLocale(locale) {
  const normalized = locale === "zh" ? "zh-CN" : locale;
  return LOCALES.includes(normalized) ? normalized : DEFAULT_LOCALE;
}

export function isSupportedLocale(locale) {
  return LOCALES.includes(locale);
}
