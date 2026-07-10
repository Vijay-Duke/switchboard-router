// @ts-check

const SINGLE_QUOTE_ESCAPE = `'"'"'`;

/** Quote one value for a POSIX shell assignment without allowing expansion. */
export function quoteShellValue(value) {
  return `'${String(value).split("'").join(SINGLE_QUOTE_ESCAPE)}'`;
}

/** Decode values emitted by quoteShellValue for status-display parsing. */
export function parseQuotedShellValue(value) {
  const text = String(value || "").trim();
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).split(SINGLE_QUOTE_ESCAPE).join("'");
  }
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

/** Shell env files are line-oriented; reject values that could add a line. */
export function isSingleLineString(value, { allowEmpty = false } = {}) {
  return typeof value === "string"
    && (allowEmpty || value.trim().length > 0)
    && !/[\0\r\n]/.test(value);
}
