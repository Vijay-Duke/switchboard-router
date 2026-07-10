// @ts-check

/**
 * Parse a ripgrep-style "file:lineno:content" line, aware of Windows drive letters.
 * "C:\\foo\\bar.js:10:x" must not treat the drive colon as the field separator.
 * @param {string} line
 * @returns {{ file: string, lineNum: string, content: string } | null}
 */
export function parseGrepLine(line) {
  if (!line) return null;
  let start = 0;
  if (/^[A-Za-z]:[\\/]/.test(line)) start = 2;
  const first = line.indexOf(":", start);
  if (first === -1) return null;
  const second = line.indexOf(":", first + 1);
  if (second === -1) return null;
  const file = line.slice(0, first);
  const lineNum = line.slice(first + 1, second);
  if (!/^\d+$/.test(lineNum)) return null;
  return { file, lineNum, content: line.slice(second + 1) };
}
