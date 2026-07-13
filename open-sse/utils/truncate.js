const UTF8_ENCODER = new TextEncoder();

function normalizeCap(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Return at most maxChars leading UTF-16 code units without splitting a pair. */
export function charSafePrefix(str, maxChars) {
  if (typeof str !== "string") return "";
  const cap = normalizeCap(maxChars);
  if (str.length <= cap) return str;
  if (cap === 0) return "";
  return str.slice(0, isHighSurrogate(str.charCodeAt(cap - 1)) ? cap - 1 : cap);
}

/** Return at most maxChars trailing UTF-16 code units without splitting a pair. */
export function charSafeSuffix(str, maxChars) {
  if (typeof str !== "string") return "";
  const cap = normalizeCap(maxChars);
  if (str.length <= cap) return str;
  if (cap === 0) return "";
  const start = str.length - cap;
  return str.slice(isLowSurrogate(str.charCodeAt(start)) ? start + 1 : start);
}

/** Return the longest UTF-8 byte-capped prefix without a trailing high surrogate. */
export function byteSafePrefix(str, maxBytes) {
  if (typeof str !== "string") return "";
  const limit = normalizeCap(maxBytes);
  if (limit === 0) return "";
  if (UTF8_ENCODER.encode(str).length <= limit) return str;

  let low = 0;
  let high = str.length;
  while (low < high) {
    const mid = low + Math.ceil((high - low) / 2);
    if (UTF8_ENCODER.encode(str.slice(0, mid)).length <= limit) low = mid;
    else high = mid - 1;
  }
  return charSafePrefix(str, low);
}
