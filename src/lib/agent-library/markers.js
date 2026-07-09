// @ts-check
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { MANAGED_MARKER, SB_NAMESPACE } from "./paths.js";
import { atomicWriteFile } from "./fs-utils.js";

/**
 * Sidecar marker always next to the skill dir (safe for both copy and symlink).
 * @param {string} destDir
 */
function sidecarMarkerPath(destDir) {
  return path.join(
    path.dirname(destDir),
    `.sb-managed-${path.basename(destDir)}.json`
  );
}

/**
 * Read ownership marker without following skill-dir symlinks into foreign trees.
 * Prefer sidecar always; only read internal marker if dest is a real directory (not a symlink).
 * @param {string} destDir
 * @returns {Promise<object|null>}
 */
async function readManagedMarker(destDir) {
  const sidecar = sidecarMarkerPath(destDir);
  if (existsSync(sidecar)) {
    try {
      const st = lstatSync(sidecar);
      if (st.isFile()) {
        return JSON.parse(await fs.readFile(sidecar, "utf-8"));
      }
    } catch {
      /* fall through */
    }
  }

  // Internal marker only when dest is a non-symlink directory (copy mode)
  try {
    if (!existsSync(destDir)) return null;
    const destSt = lstatSync(destDir);
    if (destSt.isSymbolicLink()) return null;
    if (!destSt.isDirectory()) return null;
    const internal = path.join(destDir, MANAGED_MARKER);
    if (!existsSync(internal)) return null;
    const st = lstatSync(internal);
    if (!st.isFile()) return null;
    return JSON.parse(await fs.readFile(internal, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} destDir
 * @param {{ skillId: string, libraryPath: string, linkMode: string }} meta
 */
export async function writeManagedMarker(destDir, meta) {
  const payload = {
    managedBy: "switchboard",
    namespace: SB_NAMESPACE,
    skillId: meta.skillId,
    libraryPath: meta.libraryPath,
    linkMode: meta.linkMode,
    updatedAt: new Date().toISOString(),
  };
  const body = JSON.stringify(payload, null, 2);
  // Always write sidecar next to dest so symlink mode never pollutes the library
  const sidecar = sidecarMarkerPath(destDir);
  await fs.mkdir(path.dirname(sidecar), { recursive: true });
  await atomicWriteFile(sidecar, body);

  // For copy mode also write inside the directory (helps discovery).
  // Never write through a symlink into the library.
  if (meta.linkMode === "copy") {
    try {
      const destSt = lstatSync(destDir);
      if (destSt.isDirectory() && !destSt.isSymbolicLink()) {
        await atomicWriteFile(path.join(destDir, MANAGED_MARKER), body);
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Remove markers without following skill-dir symlinks into the library.
 * @param {string} destDir
 */
export async function removeManagedMarker(destDir) {
  // Sidecar is always next to dest — safe to unlink if it's a regular file
  try {
    const sidecar = sidecarMarkerPath(destDir);
    const st = lstatSync(sidecar);
    if (st.isFile() && !st.isSymbolicLink()) {
      await fs.unlink(sidecar);
    }
  } catch {
    /* missing or not a file */
  }

  // Internal marker only when dest is a real directory (not a symlink)
  try {
    const destSt = lstatSync(destDir);
    if (!destSt.isDirectory() || destSt.isSymbolicLink()) return;
    const internal = path.join(destDir, MANAGED_MARKER);
    const st = lstatSync(internal);
    if (st.isFile() && !st.isSymbolicLink()) {
      await fs.unlink(internal);
    }
  } catch {
    /* ignore */
  }
}

/**
 * True if path is safe for Switchboard to replace/remove.
 * Uses lstat (no follow). Treats symlink→library as managed if marker/sidecar says so
 * OR if resolved target is under libraryRoot.
 *
 * @param {string} destDir
 * @param {boolean} neverOverwriteUser
 * @param {{ libraryRoot?: string|null }} [opts]
 */
export async function canManagePath(destDir, neverOverwriteUser, opts = {}) {
  // Use lstat (not existsSync) so broken symlinks are visible and replaceable
  let st = null;
  try {
    st = lstatSync(destDir);
  } catch {
    // Truly missing — still honor orphan sidecar as managed
    const marker = await readManagedMarker(destDir);
    if (marker?.managedBy === "switchboard") {
      return { ok: true, reason: "managed_sidecar_orphan", marker };
    }
    return { ok: true, reason: "missing" };
  }

  const marker = await readManagedMarker(destDir);
  if (marker?.managedBy === "switchboard") {
    return { ok: true, reason: "managed", marker };
  }

  // Symlink into our library counts as managed even without marker (legacy)
  if (st.isSymbolicLink() && opts.libraryRoot) {
    try {
      const target = realpathSync(destDir);
      const lib = path.resolve(opts.libraryRoot);
      const rel = path.relative(lib, target);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return { ok: true, reason: "symlink_into_library" };
      }
    } catch {
      /* broken link — we can replace */
      return { ok: true, reason: "broken_symlink" };
    }
  }

  // Broken / dangling symlink with no marker: safe to replace
  if (st.isSymbolicLink()) {
    try {
      realpathSync(destDir);
    } catch {
      return { ok: true, reason: "broken_symlink" };
    }
  }

  if (neverOverwriteUser) {
    return {
      ok: false,
      reason: "conflict_user_owned",
      message:
        "Path exists and is not Switchboard-managed. Skipping to protect your files.",
    };
  }

  return {
    ok: true,
    reason: "overwrite_allowed",
    message: "User allowed overwrite of non-managed path",
  };
}

/**
 * @param {string} key
 */
export function isManagedMcpKey(key) {
  return typeof key === "string" && key.startsWith(`${SB_NAMESPACE}-`);
}

/**
 * @param {string} id
 */
export function managedMcpKey(id) {
  // Prefer no dots in MCP keys (Codex TOML + safety)
  let clean = String(id || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\./g, "-")
    .replace(/^-+|-+$/g, "");
  if (!clean || clean === "." || clean === ".." || !/[a-zA-Z0-9]/.test(clean)) {
    return null;
  }
  if (clean.startsWith(`${SB_NAMESPACE}-`)) return clean;
  return `${SB_NAMESPACE}-${clean}`;
}

/**
 * Strict path containment: resolved path must be under root (no prefix tricks).
 * @param {string} candidate
 * @param {string} root
 */
export function isPathInside(candidate, root) {
  const c = path.resolve(candidate);
  const r = path.resolve(root);
  const rel = path.relative(r, c);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
