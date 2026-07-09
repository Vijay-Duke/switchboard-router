// @ts-check
import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";

/** Allowed skill folder names (alphanumeric + hyphen). */
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Resolve the on-disk skills/ directory across dev, start, and standalone layouts.
 * @returns {string|null}
 */
export function getSkillsRoot() {
  const candidates = [
    path.join(process.cwd(), "skills"),
    path.join(process.cwd(), "..", "skills"),
    // next standalone: cwd may be .next/standalone
    path.join(process.cwd(), "..", "..", "skills"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * @param {string} id
 * @returns {string|null} absolute path to SKILL.md or null if invalid / missing
 */
export function getSkillFilePath(id) {
  if (!id || typeof id !== "string" || !ID_RE.test(id)) return null;
  const root = getSkillsRoot();
  if (!root) return null;
  // Prevent path traversal — id is already constrained, join under root only
  const file = path.join(root, id, "SKILL.md");
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return null;
  return resolved;
}

/**
 * @param {string} id
 * @returns {Promise<string|null>}
 */
export async function readSkillMarkdown(id) {
  const file = getSkillFilePath(id);
  if (!file) return null;
  try {
    return await fs.readFile(file, "utf-8");
  } catch (e) {
    if (e && /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Rewrite repo-relative skill paths to fetchable API URLs for agents.
 * @param {string} markdown
 * @param {string} origin e.g. http://localhost:20128
 */
export function rewriteSkillUrls(markdown, origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  if (!base) return markdown;
  // skills/<id>/SKILL.md  or full URL ending in that path
  return String(markdown).replace(
    /(?:https?:\/\/[^\s)"']+\/)?skills\/([a-z0-9][a-z0-9_-]*)\/SKILL\.md/gi,
    `${base}/api/skills/$1`
  );
}
