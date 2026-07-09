// @ts-check
import fs from "node:fs/promises";
import path from "node:path";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { canManagePath } from "./markers.js";

/**
 * Recursively copy directory without following symlinks (reject external links).
 * @param {string} src
 * @param {string} dest
 * @param {string} [libraryRoot] — if set, symlink targets must stay under this root
 */
export async function copyDir(src, dest, libraryRoot) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    let st;
    try {
      st = lstatSync(s);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      // Do not follow / copy through symlinks outside library
      if (libraryRoot) {
        try {
          const target = realpathSync(s);
          const rel = path.relative(path.resolve(libraryRoot), target);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            continue; // skip external symlink
          }
        } catch {
          continue; // broken link
        }
      } else {
        continue;
      }
      // Valid in-library symlink: re-create as relative copy of content via realpath file/dir
      try {
        const target = realpathSync(s);
        const tst = lstatSync(target);
        if (tst.isDirectory()) await copyDir(target, d, libraryRoot);
        else await fs.copyFile(target, d);
      } catch {
        /* skip */
      }
      continue;
    }
    if (st.isDirectory()) await copyDir(s, d, libraryRoot);
    else if (st.isFile()) await fs.copyFile(s, d);
  }
}

/**
 * Remove path without following symlinks into foreign trees.
 * Uses lstat so broken symlinks are unlinked (existsSync would miss them).
 * @param {string} dest
 */
export async function removePath(dest) {
  let st;
  try {
    st = await fs.lstat(dest);
  } catch {
    return; // truly missing
  }
  if (st.isSymbolicLink() || st.isFile()) {
    await fs.unlink(dest);
    return;
  }
  if (st.isDirectory()) {
    await fs.rm(dest, { recursive: true, force: true });
  }
}

/**
 * Re-check ownership immediately before destructive replace (TOCTOU).
 * @param {string} destDir
 * @param {string} [libraryRoot]
 * @param {boolean} [neverOverwriteUser]
 */
async function assertCanReplace(destDir, libraryRoot, neverOverwriteUser = true) {
  // Missing path is fine — we can create
  try {
    await fs.lstat(destDir);
  } catch {
    return;
  }

  const gate = await canManagePath(destDir, neverOverwriteUser !== false, {
    libraryRoot,
  });
  if (!gate.ok) {
    const e = new Error(gate.message || "Path is not Switchboard-managed");
    // @ts-ignore
    e.code = "conflict";
    // @ts-ignore
    e.reason = gate.reason;
    throw e;
  }
}

/**
 * Install skill from library to agent dest using copy or symlink.
 * Stages copy into temp then renames; re-validates ownership before replace.
 * @param {string} srcDir
 * @param {string} destDir
 * @param {"copy"|"symlink"} mode
 * @param {string} [libraryRoot]
 * @param {{ neverOverwriteUser?: boolean }} [opts]
 */
export async function linkSkill(srcDir, destDir, mode, libraryRoot, opts = {}) {
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  const neverOverwrite = opts.neverOverwriteUser !== false;

  if (mode === "symlink") {
    await assertCanReplace(destDir, libraryRoot, neverOverwrite);
    try {
      await removePath(destDir);
      await fs.symlink(srcDir, destDir, "dir");
      return { mode: "symlink" };
    } catch (e) {
      if (e?.code === "conflict") throw e;
      // Fall back to copy
      return copyAtomic(srcDir, destDir, libraryRoot, e?.message, neverOverwrite);
    }
  }

  return copyAtomic(srcDir, destDir, libraryRoot, undefined, neverOverwrite);
}

/**
 * Stage into temp dir, swap with rename, clean backup. Re-checks gate before swap.
 * @param {string} srcDir
 * @param {string} destDir
 * @param {string} [libraryRoot]
 * @param {string} [symlinkErr]
 * @param {boolean} [neverOverwriteUser]
 */
async function copyAtomic(
  srcDir,
  destDir,
  libraryRoot,
  symlinkErr,
  neverOverwriteUser = true
) {
  const tmp = `${destDir}.sb-tmp-${process.pid}-${Date.now()}`;
  const bak = `${destDir}.sb-bak-${process.pid}-${Date.now()}`;
  try {
    await removePath(tmp);
    await copyDir(srcDir, tmp, libraryRoot);

    // Final TOCTOU check immediately before replace
    await assertCanReplace(destDir, libraryRoot, neverOverwriteUser);

    // Swap: move existing aside (if any), then rename tmp → dest
    let hadDest = false;
    try {
      await fs.lstat(destDir);
      hadDest = true;
    } catch {
      hadDest = false;
    }

    if (hadDest) {
      await removePath(bak);
      try {
        await fs.rename(destDir, bak);
      } catch {
        // Cross-device or busy: fall back to remove then rename
        await removePath(destDir);
      }
    }

    try {
      await fs.rename(tmp, destDir);
    } catch (e) {
      // Restore backup if we moved dest aside
      if (hadDest) {
        try {
          await fs.lstat(bak);
          await fs.rename(bak, destDir);
        } catch {
          /* best effort */
        }
      }
      throw e;
    }

    // Success — drop backup
    try {
      await removePath(bak);
    } catch {
      /* ignore */
    }

    return symlinkErr
      ? {
          mode: "copy",
          fallbackFrom: "symlink",
          warning: symlinkErr || "symlink failed; used copy",
        }
      : { mode: "copy" };
  } catch (e) {
    try {
      await removePath(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * @param {string} destDir
 */
export function inspectLink(destDir) {
  try {
    // lstat even if broken symlink — existsSync follows and returns false for broken
    let st;
    try {
      st = lstatSync(destDir);
    } catch {
      return { exists: false };
    }
    if (st.isSymbolicLink()) {
      let target = null;
      let broken = false;
      try {
        target = readlinkSync(destDir);
        try {
          realpathSync(destDir);
        } catch {
          broken = true;
        }
      } catch {
        broken = true;
      }
      return { exists: true, type: "symlink", target, broken };
    }
    if (st.isDirectory()) return { exists: true, type: "directory" };
    return { exists: true, type: "other" };
  } catch (e) {
    return { exists: false, error: e?.message };
  }
}
