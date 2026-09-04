// @ts-check
/**
 * Shell-style word splitting for MCP stdio args input.
 * T5: naive whitespace split broke quoted args like --header "Authorization: Bearer x".
 */

/**
 * Split a shell-style string into words. Respects single/double quotes and
 * backslash escapes. Unterminated quotes are treated as extending to end of input.
 * @param {string} input
 * @returns {string[]}
 */
export function splitShellWords(input) {
  const out = [];
  let cur = "";
  let hasWord = false;
  let quote = "";
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === "\\" && quote === '"' && input[i + 1] !== undefined) {
        cur += input[++i];
      } else if (c === quote) {
        quote = "";
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      hasWord = true; // even an empty quoted string is a word
    } else if (c === "\\" && input[i + 1] !== undefined) {
      cur += input[++i];
    } else if (/\s/.test(c)) {
      if (cur || hasWord) out.push(cur);
      cur = "";
      hasWord = false;
    } else {
      cur += c;
      hasWord = true;
    }
  }
  if (cur || hasWord) out.push(cur);
  return out;
}

/**
 * Inverse of splitShellWords: join args into one display string, quoting words
 * that contain whitespace/quotes so they survive a re-split.
 * @param {string[]} args
 * @returns {string}
 */
export function formatShellWords(args) {
  return args
    .map((a) => (/[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a))
    .join(" ");
}
