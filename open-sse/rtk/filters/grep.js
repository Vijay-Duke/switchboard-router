// Port of grep_wrapper (rtk/src/cmds/system/pipe_cmd.rs:50-86)
// Input format: "file:lineno:content" — Windows-drive-aware (see parseGrepLine)
import { GREP_PER_FILE_MAX } from "../constants.js";
import { parseGrepLine } from "../autodetect.js";

export function grep(input) {
  const byFile = new Map();
  let total = 0;

  for (const line of input.split("\n")) {
    const parsed = parseGrepLine(line);
    if (!parsed) continue;
    const { file, lineNum: lineNumStr, content } = parsed;
    total++;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push([lineNumStr, content]);
  }

  if (total === 0) return input;

  // Rust: files.sort_by_key(|(f, _)| *f)
  const files = Array.from(byFile.keys()).sort();
  let out = `${total} matches in ${files.length}F:\n\n`;

  for (const file of files) {
    const matches = byFile.get(file);
    out += `[file] ${file} (${matches.length}):\n`;
    const show = matches.slice(0, GREP_PER_FILE_MAX);
    for (const [lineNum, content] of show) {
      // Rust: format!("  {:>4}: {}", line_num, content.trim())
      out += `  ${lineNum.padStart(4)}: ${content.trim()}\n`;
    }
    if (matches.length > GREP_PER_FILE_MAX) {
      out += `  +${matches.length - GREP_PER_FILE_MAX}\n`;
    }
    out += "\n";
  }

  return out;
}

grep.filterName = "grep";
