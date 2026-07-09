// Port of git::format_status_output (rtk/src/cmds/git/git.rs:619-730)
// Output format:
//   * <branch>
//   + Staged: N files
//      path1
//      ... +K more
//   ~ Modified: N files
//   ? Untracked: N files
//   conflicts: N files
//   clean — nothing to commit
import { STATUS_MAX_FILES, STATUS_MAX_UNTRACKED } from "../constants.js";

export function gitStatus(input) {
  const lines = input.split("\n");
  if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
    return "Clean working tree";
  }

  let branch = "";
  const stagedFiles = [];
  const modifiedFiles = [];
  const untrackedFiles = [];
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;
  let inUntrackedSection = false;

  for (const raw of lines) {
    if (!raw.trim()) continue;

    // Long-form branch detection (LLM usually sends this, not porcelain)
    const longBranch = raw.match(/^On branch (\S+)/);
    if (longBranch) { branch = longBranch[1]; inUntrackedSection = false; continue; }

    // Porcelain branch header: "## main...origin/main"
    if (raw.startsWith("##")) { branch = raw.replace(/^##\s*/, ""); inUntrackedSection = false; continue; }

    // Long-form section headers
    if (/^Untracked files:/i.test(raw.trim())) {
      inUntrackedSection = true;
      continue;
    }
    if (/^(Changes not staged|Changes to be committed|Unmerged paths):/i.test(raw.trim())) {
      inUntrackedSection = false;
      continue;
    }

    // Porcelain status (2 chars + space + path)
    if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      inUntrackedSection = false;
      const x = raw[0];
      const y = raw[1];
      const file = raw.slice(3);

      if (raw.slice(0, 2) === "??") {
        untracked++;
        untrackedFiles.push(file);
        continue;
      }

      if ("MADRC".includes(x)) {
        staged++;
        stagedFiles.push(file);
      } else if (x === "U") {
        conflicts++;
      }

      if (y === "M" || y === "D") {
        modified++;
        modifiedFiles.push(file);
      }
      continue;
    }

    // Long form fallback ("modified:   path", "new file:   path", ...)
    const longMatch = raw.match(/^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/);
    if (longMatch) {
      inUntrackedSection = false;
      const kind = longMatch[1];
      const path = longMatch[2].trim();
      if (kind === "both modified") { conflicts++; }
      else if (kind === "modified" || kind === "deleted") { modified++; modifiedFiles.push(path); }
      else if (kind === "new file" || kind === "renamed") { staged++; stagedFiles.push(path); }
      continue;
    }

    // Bare paths under "Untracked files:" section (long-form git status)
    if (inUntrackedSection) {
      const t = raw.trim();
      // Skip hints like "use git add..." / "(use \""
      if (!t || t.startsWith("(") || t.startsWith("use ")) continue;
      untracked++;
      untrackedFiles.push(t);
    }
  }

  let out = "";
  if (branch) out += `* ${branch}\n`;

  if (staged > 0) {
    out += `+ Staged: ${staged} files\n`;
    for (const f of stagedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}\n`;
    if (stagedFiles.length > STATUS_MAX_FILES) {
      out += `   ... +${stagedFiles.length - STATUS_MAX_FILES} more\n`;
    }
  }

  if (modified > 0) {
    out += `~ Modified: ${modified} files\n`;
    for (const f of modifiedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}\n`;
    if (modifiedFiles.length > STATUS_MAX_FILES) {
      out += `   ... +${modifiedFiles.length - STATUS_MAX_FILES} more\n`;
    }
  }

  if (untracked > 0) {
    out += `? Untracked: ${untracked} files\n`;
    for (const f of untrackedFiles.slice(0, STATUS_MAX_UNTRACKED)) out += `   ${f}\n`;
    if (untrackedFiles.length > STATUS_MAX_UNTRACKED) {
      out += `   ... +${untrackedFiles.length - STATUS_MAX_UNTRACKED} more\n`;
    }
  }

  if (conflicts > 0) {
    out += `conflicts: ${conflicts} files\n`;
  }

  if (staged === 0 && modified === 0 && untracked === 0 && conflicts === 0) {
    out += "clean — nothing to commit\n";
  }

  return out.replace(/\n+$/, "");
}

gitStatus.filterName = "git-status";
