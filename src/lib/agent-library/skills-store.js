// @ts-check
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  ensureLibraryDirs,
  getSkillsDir,
  librarySkillDirName,
} from "./paths.js";
import { getSkillsRoot, readSkillMarkdown } from "@/lib/skills/paths.js";
import { SKILLS as PRODUCT_SKILLS } from "@/shared/constants/skills.js";

/**
 * @param {string} libraryRoot
 */
export async function listLibrarySkills(libraryRoot) {
  ensureLibraryDirs(libraryRoot);
  const dir = getSkillsDir(libraryRoot);
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const skillMd = path.join(dir, name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let description = "";
    let title = name;
    try {
      const raw = await fs.readFile(skillMd, "utf-8");
      const mName = raw.match(/^name:\s*(.+)$/m);
      const mDesc = raw.match(/^description:\s*(.+)$/m);
      if (mName) title = mName[1].trim().replace(/^["']|["']$/g, "");
      if (mDesc) description = mDesc[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      /* ignore */
    }
    const st = await fs.stat(skillMd);
    out.push({
      id: name,
      title,
      description,
      path: path.join(dir, name),
      source: "library",
      updatedAt: st.mtime.toISOString(),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Copy product skills from repo skills/ into library when missing or force.
 * @param {string} libraryRoot
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureProductSkillsInLibrary(libraryRoot, opts = {}) {
  ensureLibraryDirs(libraryRoot);
  const productRoot = getSkillsRoot();
  const results = [];
  if (!productRoot) {
    return { ok: false, results, error: "Product skills directory not found" };
  }

  for (const meta of PRODUCT_SKILLS) {
    const id = librarySkillDirName(meta.id);
    const dest = path.join(getSkillsDir(libraryRoot), id);
    const destMd = path.join(dest, "SKILL.md");
    if (existsSync(destMd) && !opts.force) {
      results.push({ id, action: "skipped_exists" });
      continue;
    }
    const src = await readSkillMarkdown(meta.id);
    if (!src) {
      results.push({ id, action: "missing_source" });
      continue;
    }
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(destMd, src, "utf-8");
    results.push({ id, action: "installed" });
  }
  return { ok: true, results };
}

/**
 * Install a skill from raw markdown text.
 * @param {string} libraryRoot
 * @param {{ id: string, markdown: string, source?: string }} args
 */
export async function installSkillMarkdown(libraryRoot, args) {
  ensureLibraryDirs(libraryRoot);
  const id = librarySkillDirName(args.id);
  if (!id) throw new Error("Invalid skill id");
  const dest = path.join(getSkillsDir(libraryRoot), id);
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, "SKILL.md"), args.markdown, "utf-8");
  // provenance
  await fs.writeFile(
    path.join(dest, ".source.json"),
    JSON.stringify(
      {
        source: args.source || "manual",
        installedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf-8"
  );
  return { id, path: dest };
}

/**
 * @param {string} libraryRoot
 * @param {string} skillId
 */
export async function removeLibrarySkill(libraryRoot, skillId) {
  const id = librarySkillDirName(skillId);
  if (!id) throw new Error("Invalid skill id");
  const skillsRoot = path.resolve(getSkillsDir(libraryRoot));
  const dest = path.resolve(skillsRoot, id);
  // Containment: dest must be a direct child of skills root
  if (path.dirname(dest) !== skillsRoot) {
    throw new Error("Invalid skill path");
  }
  if (!existsSync(dest)) return { removed: false };
  await fs.rm(dest, { recursive: true, force: true });
  return { removed: true, id };
}

/**
 * @param {string} libraryRoot
 * @param {string} skillId
 */
export function getLibrarySkillPath(libraryRoot, skillId) {
  const id = librarySkillDirName(skillId);
  return path.join(getSkillsDir(libraryRoot), id);
}
