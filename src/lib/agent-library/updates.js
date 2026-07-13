// @ts-check
/**
 * Update detection + hash-pinned refresh for URL-imported library skills.
 * Checks run only on user action / Skills-tab load — never in the background.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getSkillsDir, librarySkillDirName } from "./paths.js";
import { installSkillMarkdown } from "./skills-store.js";
import { fetchSkillMarkdown, sha256Hex } from "./catalog.js";

/** Bound total work per check run — dashboard-load path must stay cheap. */
export const MAX_SKILLS_PER_CHECK = 20;
const CHECK_TIMEOUT_MS = 10_000;

/**
 * @param {string} libraryRoot
 * @param {string} id
 */
function skillDir(libraryRoot, id) {
  return path.join(getSkillsDir(libraryRoot), id);
}

/**
 * @param {string} libraryRoot
 * @param {string} id
 * @returns {Promise<Record<string, any>|null>}
 */
async function readSourceMeta(libraryRoot, id) {
  try {
    const raw = await fs.readFile(
      path.join(skillDir(libraryRoot, id), ".source.json"),
      "utf-8"
    );
    const meta = JSON.parse(raw);
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} libraryRoot
 * @param {string} id
 * @param {Record<string, any>} meta
 */
async function writeSourceMeta(libraryRoot, id, meta) {
  await fs.writeFile(
    path.join(skillDir(libraryRoot, id), ".source.json"),
    JSON.stringify(meta, null, 2),
    "utf-8"
  );
}

/** @param {Record<string, any>|null} meta */
function sourceUrl(meta) {
  const s = typeof meta?.source === "string" ? meta.source : "";
  return s.startsWith("url:") ? s.slice(4) : null;
}

/**
 * Installed-content hash: stored value, else computed from disk (legacy installs).
 * @param {string} libraryRoot
 * @param {string} id
 * @param {Record<string, any>|null} meta
 */
async function installedHash(libraryRoot, id, meta) {
  if (typeof meta?.contentHash === "string" && meta.contentHash) {
    return meta.contentHash;
  }
  const md = await fs.readFile(
    path.join(skillDir(libraryRoot, id), "SKILL.md"),
    "utf-8"
  );
  return sha256Hex(md);
}

/**
 * Check every url-sourced library skill for upstream changes.
 * Per-skill fail-open: one bad source never breaks the run.
 * @param {string} libraryRoot
 * @returns {Promise<{ results: Array<{ id: string, status: "fresh"|"update"|"error", message?: string }>, skipped: number }>}
 */
export async function checkSkillUpdates(libraryRoot) {
  let names = [];
  try {
    names = await fs.readdir(getSkillsDir(libraryRoot));
  } catch {
    return { results: [], skipped: 0 };
  }

  const candidates = [];
  for (const name of names) {
    const meta = await readSourceMeta(libraryRoot, name);
    const url = sourceUrl(meta);
    if (url && meta) candidates.push({ id: name, url, meta });
  }

  const checked = candidates.slice(0, MAX_SKILLS_PER_CHECK);
  const skipped = candidates.length - checked.length;

  const results = await Promise.all(
    checked.map(async ({ id, url, meta }) => {
      try {
        const localHash = await installedHash(libraryRoot, id, meta);
        const res = await fetchSkillMarkdown(url, {
          timeoutMs: CHECK_TIMEOUT_MS,
          etag: typeof meta.etag === "string" ? meta.etag : null,
        });
        if (!res.ok) {
          return { id, status: /** @type {const} */ ("error"), message: res.message };
        }

        const now = new Date().toISOString();
        if (res.notModified) {
          await writeSourceMeta(libraryRoot, id, {
            ...meta,
            contentHash: localHash,
            lastChecked: now,
          });
          return { id, status: /** @type {const} */ ("fresh") };
        }

        const remoteHash = sha256Hex(res.markdown);
        // Always refresh the validator — a stale ETag forces full downloads forever.
        await writeSourceMeta(libraryRoot, id, {
          ...meta,
          contentHash: localHash,
          etag: res.etag || meta.etag || null,
          lastChecked: now,
        });
        return {
          id,
          status: /** @type {const} */ (remoteHash === localHash ? "fresh" : "update"),
        };
      } catch (e) {
        return {
          id,
          status: /** @type {const} */ ("error"),
          message: /** @type {any} */ (e)?.message || "check failed",
        };
      }
    })
  );

  return { results, skipped };
}

/**
 * Full incoming content for review-before-overwrite (previewUrl truncates; this must not).
 * @param {string} libraryRoot
 * @param {string} skillId
 */
export async function previewSkillUpdate(libraryRoot, skillId) {
  const id = librarySkillDirName(skillId);
  if (!id) return { ok: false, error: "invalid_id", message: "Invalid skill id" };
  const meta = await readSourceMeta(libraryRoot, id);
  const url = sourceUrl(meta);
  if (!url) {
    return { ok: false, error: "not_url_source", message: "Skill was not installed from a URL" };
  }
  const res = await fetchSkillMarkdown(url);
  if (!res.ok) return res;
  if (res.notModified || !("markdown" in res)) {
    return { ok: false, error: "fetch_failed", message: "Unexpected empty response" };
  }
  return { ok: true, markdown: res.markdown, contentHash: sha256Hex(res.markdown) };
}

/**
 * Hash-pinned update: installs exactly the bytes the user previewed, or refuses.
 * @param {string} libraryRoot
 * @param {string} skillId
 * @param {{ confirmed: boolean, expectedHash: string }} args
 */
export async function updateSkillFromSource(libraryRoot, skillId, args) {
  if (args?.confirmed !== true) {
    return {
      ok: false,
      error: "confirmation_required",
      message:
        "Updates require explicit confirmation. Remote content can instruct agents to run shell commands — review the markdown first.",
    };
  }
  if (typeof args.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(args.expectedHash)) {
    return { ok: false, error: "expected_hash_required", message: "Preview first — expectedHash missing" };
  }

  const id = librarySkillDirName(skillId);
  if (!id) return { ok: false, error: "invalid_id", message: "Invalid skill id" };
  const meta = await readSourceMeta(libraryRoot, id);
  const url = sourceUrl(meta);
  if (!url) {
    return { ok: false, error: "not_url_source", message: "Skill was not installed from a URL" };
  }

  const res = await fetchSkillMarkdown(url);
  if (!res.ok) return res;
  if (res.notModified || !("markdown" in res)) {
    return { ok: false, error: "fetch_failed", message: "Unexpected empty response" };
  }

  const hash = sha256Hex(res.markdown);
  if (hash !== args.expectedHash) {
    return {
      ok: false,
      error: "content_changed",
      message: "Upstream content changed since preview — preview again before updating.",
    };
  }

  const installed = await installSkillMarkdown(libraryRoot, {
    id,
    markdown: res.markdown,
    source: `url:${url}`,
    contentHash: hash,
    etag: res.etag || null,
  });

  return {
    ok: true,
    ...installed,
    warning:
      "Skill updated in the library only. Run Apply Sync to push the new version to agents.",
  };
}
