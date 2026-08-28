// @ts-check
import { installSkillMarkdown } from "./skills-store.js";
import { librarySkillDirName } from "./paths.js";
import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";

/** Hard cap on remote SKILL.md size — anything bigger is not a skill file. */
export const MAX_SKILL_BYTES = 512 * 1024;

/** @param {string} text */
export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Known safe catalog sources (user still must confirm install).
 */
export const CATALOG_PRESETS = [
  {
    id: "anthropic-frontend-design",
    name: "frontend-design (Anthropic)",
    description: "Production UI aesthetics — anti AI-slop",
    skillId: "frontend-design",
    rawUrl:
      "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md",
    trusted: true,
  },
  {
    id: "anthropic-skill-creator",
    name: "skill-creator (Anthropic)",
    description: "Meta-skill to author new Agent Skills",
    skillId: "skill-creator",
    rawUrl:
      "https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md",
    trusted: true,
  },
  {
    id: "anthropic-webapp-testing",
    name: "webapp-testing (Anthropic)",
    description: "Playwright testing for local web apps",
    skillId: "webapp-testing",
    rawUrl:
      "https://raw.githubusercontent.com/anthropics/skills/main/skills/webapp-testing/SKILL.md",
    trusted: true,
  },
];

const ALLOWED_HOST_SUFFIXES = [
  "githubusercontent.com",
  "github.com",
  "raw.githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "jsdelivr.net",
  "cdn.jsdelivr.net",
];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80")) return true;
    return false;
  }
  return true;
}

/**
 * SSRF guard: https only, allowlisted public hosts, no private IPs after DNS.
 * @param {string} urlStr
 * @returns {Promise<{ ok: true, url: URL }|{ ok: false, error: string, message: string }>}
 */
export async function assertSafeCatalogUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return { ok: false, error: "invalid_url", message: "Invalid URL" };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: "https_required",
      message: "Catalog URLs must use https://",
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      error: "credentials_forbidden",
      message: "URLs with embedded credentials are not allowed",
    };
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return {
      ok: false,
      error: "private_host",
      message: "Local/private hosts are not allowed",
    };
  }
  const allowed = ALLOWED_HOST_SUFFIXES.some(
    (s) => host === s || host.endsWith(`.${s}`)
  );
  if (!allowed) {
    return {
      ok: false,
      error: "host_not_allowlisted",
      message: `Host not allowlisted. Allowed: ${ALLOWED_HOST_SUFFIXES.join(", ")}`,
    };
  }

  try {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        return {
          ok: false,
          error: "private_ip",
          message: `Host resolves to private IP (${r.address})`,
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: "dns_failed",
      message: e?.message || "DNS lookup failed",
    };
  }

  return { ok: true, url };
}

/**
 * Fetch + validate a remote SKILL.md through the SSRF guard and size cap.
 * Shared by install, update-check, preview, and update paths.
 * @param {string} urlStr
 * @param {{ timeoutMs?: number, etag?: string|null }} [opts]
 * @returns {Promise<
 *   | { ok: true, notModified: true }
 *   | { ok: true, notModified?: false, markdown: string, etag: string|null }
 *   | { ok: false, error: string, message: string }
 * >}
 */
export async function fetchSkillMarkdown(urlStr, opts = {}) {
  const safe = await assertSafeCatalogUrl(urlStr);
  if (!safe.ok) return safe;

  /** @type {Record<string,string>} */
  const headers = { Accept: "text/plain, text/markdown, */*" };
  if (opts.etag) headers["If-None-Match"] = opts.etag;

  let res;
  try {
    res = await fetch(safe.url.toString(), {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      redirect: "error", // no open redirects to private hosts
    });
  } catch (e) {
    return {
      ok: false,
      error: "fetch_failed",
      message: e?.message || "Failed to fetch skill",
    };
  }

  if (res.status === 304) return { ok: true, notModified: true };

  if (!res.ok) {
    return {
      ok: false,
      error: "http_error",
      message: `HTTP ${res.status} fetching skill`,
    };
  }

  const contentLength = Number(res.headers.get("content-length") || 0);
  if (contentLength > MAX_SKILL_BYTES) {
    return {
      ok: false,
      error: "too_large",
      message: `Skill exceeds ${MAX_SKILL_BYTES} byte limit`,
    };
  }

  const markdown = await res.text();
  if (markdown.length > MAX_SKILL_BYTES) {
    return {
      ok: false,
      error: "too_large",
      message: `Skill exceeds ${MAX_SKILL_BYTES} byte limit`,
    };
  }
  if (!markdown || markdown.length < 20) {
    return { ok: false, error: "empty", message: "Remote skill content empty" };
  }
  if (!/^---[\s\S]*?name:\s*/m.test(markdown) && !/^#\s+/m.test(markdown)) {
    return {
      ok: false,
      error: "invalid_skill",
      message: "Content does not look like a SKILL.md",
    };
  }
  if (/<html[\s>]/i.test(markdown) && !markdown.includes("name:")) {
    return {
      ok: false,
      error: "not_markdown",
      message: "URL returned HTML, not a skill markdown file",
    };
  }

  return { ok: true, markdown, etag: res.headers.get("etag") };
}

/**
 * @param {string} libraryRoot
 * @param {{
 *   skillId: string,
 *   url: string,
 *   confirmed: boolean,
 *   requireConfirm: boolean,
 * }} args
 */
export async function installFromUrl(libraryRoot, args) {
  if (args.requireConfirm && args.confirmed !== true) {
    return {
      ok: false,
      error: "confirmation_required",
      message:
        "Catalog installs require explicit confirmation. Remote content can instruct agents to run shell commands — review the markdown first.",
    };
  }

  const skillId = librarySkillDirName(args.skillId);
  if (!skillId) {
    return { ok: false, error: "invalid_id", message: "Invalid skill id" };
  }

  const fetched = await fetchSkillMarkdown(args.url);
  if (!fetched.ok) return fetched;
  if (fetched.notModified || !("markdown" in fetched)) {
    // Unconditional fetch never yields 304; guard for type safety.
    return { ok: false, error: "fetch_failed", message: "Unexpected empty response" };
  }
  const { markdown, etag } = fetched;

  const installed = await installSkillMarkdown(libraryRoot, {
    id: skillId,
    markdown,
    source: `url:${args.url}`,
    contentHash: sha256Hex(markdown),
    etag: etag || null,
  });

  return {
    ok: true,
    ...installed,
    warning:
      "Skill markdown stored in the library only. It is not active on agents until you click Apply Sync. Review SKILL.md for any shell/network instructions before enabling.",
  };
}

/**
 * @param {string} url
 */
export async function previewUrl(url) {
  const safe = await assertSafeCatalogUrl(url);
  if (!safe.ok) return safe;
  try {
    const res = await fetch(safe.url.toString(), {
      headers: { Accept: "text/plain, text/markdown, */*" },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    return {
      ok: true,
      preview: text.slice(0, 4000),
      truncated: text.length > 4000,
      bytes: text.length,
    };
  } catch (e) {
    return { ok: false, error: e?.message || "fetch failed" };
  }
}

/**
 * Parse an arbitrary user input string (CLI command, repo identifier, GitHub URL, raw URL)
 * into a structured skill source target.
 *
 * Supported formats:
 * - "npx skills add citrolabs/ego-lite"
 * - "skills add citrolabs/ego-lite"
 * - "citrolabs/ego-lite"
 * - "citrolabs/ego-lite@main"
 * - "github.com/citrolabs/ego-lite"
 * - "https://github.com/citrolabs/ego-lite"
 * - "https://github.com/citrolabs/ego-lite/tree/main/skills/ego-browser"
 * - "https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/SKILL.md"
 * - "https://raw.githubusercontent.com/citrolabs/ego-lite/main/skills/ego-browser/SKILL.md"
 *
 * @param {string} input
 * @returns {{
 *   type: "github_repo" | "direct_url" | "invalid",
 *   owner?: string,
 *   repo?: string,
 *   branch?: string,
 *   subpath?: string,
 *   url?: string,
 *   suggestedId?: string,
 *   error?: string
 * }}
 */
export function parseSkillInput(input) {
  let s = String(input || "").trim();
  if (!s) return { type: "invalid", error: "Empty input" };

  // Strip wrapping quotes
  s = s.replace(/^["'`]|["'`]$/g, "").trim();

  // Strip CLI prefixes (e.g. `npx skills add`, `skills add`, `npx switchboard skill add`, `switchboard skill add`, `add`)
  s = s.replace(/^(?:npx\s+)?(?:skills|switchboard|agentsync|agent-library)\s+(?:add|install)\s+/i, "");
  s = s.replace(/^(?:add|install)\s+/i, "");

  // Strip CLI flags (e.g. -g, --global, -y, --yes, etc.)
  const tokens = s.split(/\s+/).filter((token) => {
    return !/^-(?:g|y|p|d|f|v)$|^--(?:global|yes|project|confirm|dry-run|force|verbose)$/i.test(token);
  });
  s = tokens.join(" ").trim();
  s = s.replace(/^["'`]|["'`]$/g, "").trim();

  if (!s) return { type: "invalid", error: "Empty skill target" };

  // Direct URLs or GitHub URLs
  if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      return { type: "invalid", error: "Invalid URL" };
    }

    const host = u.hostname.toLowerCase();
    const pathname = u.pathname.replace(/^\/+|\/+$/g, "");
    const segments = pathname.split("/").filter(Boolean);

    // Case 1: raw.githubusercontent.com
    if (host === "raw.githubusercontent.com" || host.endsWith(".githubusercontent.com")) {
      if (segments.length >= 3) {
        const owner = segments[0];
        const repo = segments[1];
        const branch = segments[2];
        const filePath = segments.slice(3).join("/");
        let suggestedId = "";
        if (filePath.endsWith("SKILL.md")) {
          const parts = filePath.split("/").filter(Boolean);
          suggestedId = parts.length > 1 ? parts[parts.length - 2] : repo;
        } else {
          suggestedId = repo;
        }
        return {
          type: "direct_url",
          url: s,
          suggestedId: librarySkillDirName(suggestedId) || "skill",
        };
      }
      return { type: "direct_url", url: s };
    }

    // Case 2: github.com
    if (host === "github.com" || host === "www.github.com") {
      if (segments.length >= 2) {
        const owner = segments[0];
        const repo = segments[1].replace(/\.git$/i, "");

        // e.g. /owner/repo/blob/branch/path/to/SKILL.md
        if (segments[2] === "blob" && segments.length >= 4) {
          const branch = segments[3];
          const subpath = segments.slice(4).join("/");
          const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${subpath}`;
          let suggestedId = repo;
          if (subpath.endsWith("SKILL.md")) {
            const parts = subpath.split("/").filter(Boolean);
            suggestedId = parts.length > 1 ? parts[parts.length - 2] : repo;
          }
          return {
            type: "direct_url",
            url: rawUrl,
            suggestedId: librarySkillDirName(suggestedId) || "skill",
          };
        }

        // e.g. /owner/repo/tree/branch/subpath
        if (segments[2] === "tree" && segments.length >= 4) {
          const branch = segments[3];
          const subpath = segments.slice(4).join("/");
          return {
            type: "github_repo",
            owner,
            repo,
            branch: branch || "main",
            subpath: subpath || undefined,
          };
        }

        // Standard /owner/repo
        return {
          type: "github_repo",
          owner,
          repo,
          branch: "main",
        };
      }
    }

    // Other direct URL (GitLab, custom CDN, etc.)
    let suggestedId = "skill";
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      if (last.toLowerCase() === "skill.md" && segments.length > 1) {
        suggestedId = segments[segments.length - 2];
      } else {
        suggestedId = last.replace(/\.[^.]+$/, "");
      }
    }
    return {
      type: "direct_url",
      url: s,
      suggestedId: librarySkillDirName(suggestedId) || "skill",
    };
  }

  // Strip github: prefix or github.com/ prefix
  s = s.replace(/^(?:github:|github\.com\/)/i, "").trim();

  // Pattern: owner/repo with optional @branch and optional subpath
  // e.g. citrolabs/ego-lite, citrolabs/ego-lite@main, citrolabs/ego-lite/skills/ego-browser
  const match = s.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:@([a-zA-Z0-9_.-]+))?(?:\/(.*))?$/);
  if (match) {
    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, "");
    const branch = match[3] || "main";
    const subpath = match[4] || undefined;
    return {
      type: "github_repo",
      owner,
      repo,
      branch,
      subpath,
    };
  }

  return { type: "invalid", error: `Unrecognized skill format: "${input}"` };
}

/**
 * Query GitHub repository tree or probe candidate paths to discover SKILL.md files.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} [branch]
 * @param {string} [subpath]
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function findSkillsInGitHubRepo(owner, repo, branch = "main", subpath, opts = {}) {
  const repoSlug = `${owner}/${repo}`;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  /** @type {Array<{ skillId: string, path: string, rawUrl: string, title?: string, description?: string, preview?: string, bytes?: number }>} */
  const discovered = [];

  // Helper to query GitHub tree API for a branch
  async function queryTreeApi(targetBranch) {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${targetBranch}?recursive=1`;
    const safe = await assertSafeCatalogUrl(apiUrl);
    if (!safe.ok) return null;

    try {
      const res = await fetch(safe.url.toString(), {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Switchboard-Agent-Library/1.0",
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !Array.isArray(data.tree)) return null;
      return data.tree;
    } catch {
      return null;
    }
  }

  let effectiveBranch = branch;
  let tree = await queryTreeApi(effectiveBranch);

  // If default "main" failed, try "master" as well
  if (!tree && branch === "main") {
    const masterTree = await queryTreeApi("master");
    if (masterTree) {
      tree = masterTree;
      effectiveBranch = "master";
    }
  }

  if (tree && tree.length > 0) {
    for (const item of tree) {
      if (item.type !== "blob") continue;
      const p = item.path;
      if (p !== "SKILL.md" && !p.endsWith("/SKILL.md")) continue;

      if (subpath && !p.startsWith(subpath)) continue;

      // Extract skillId
      let candidateId = repo;
      if (p === "SKILL.md") {
        candidateId = repo;
      } else {
        const segments = p.split("/").filter(Boolean);
        candidateId = segments.length > 1 ? segments[segments.length - 2] : repo;
      }

      const skillId = librarySkillDirName(candidateId) || "skill";
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${effectiveBranch}/${p}`;

      discovered.push({
        skillId,
        path: p,
        rawUrl,
      });
    }
  }

  // Fallback: if tree API failed or was empty, probe standard candidate locations
  if (discovered.length === 0) {
    const probeCandidates = [
      { path: "SKILL.md", skillId: repo },
      { path: `skills/${repo}/SKILL.md`, skillId: repo },
      ...(subpath ? [{ path: `${subpath.replace(/\/+$/, "")}/SKILL.md`, skillId: subpath.split("/").pop() || repo }] : []),
      { path: `skills/ego-browser/SKILL.md`, skillId: "ego-browser" },
      { path: `.claude/skills/${repo}/SKILL.md`, skillId: repo },
      { path: `.agents/skills/${repo}/SKILL.md`, skillId: repo },
    ];

    for (const cand of probeCandidates) {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${effectiveBranch}/${cand.path}`;
      const probe = await fetchSkillMarkdown(rawUrl, { timeoutMs: 5000 });
      if (probe.ok && "markdown" in probe) {
        let title = cand.skillId;
        let description = "";
        const mName = probe.markdown.match(/^name:\s*(.+)$/m);
        const mDesc = probe.markdown.match(/^description:\s*(.+)$/m);
        if (mName) title = mName[1].trim().replace(/^["']|["']$/g, "");
        if (mDesc) description = mDesc[1].trim().replace(/^["']|["']$/g, "");
        const skillId = librarySkillDirName(mName ? mName[1] : cand.skillId) || cand.skillId;

        discovered.push({
          skillId,
          path: cand.path,
          rawUrl,
          title,
          description,
          preview: probe.markdown.slice(0, 4000),
          bytes: probe.markdown.length,
        });
        break; // found one valid candidate
      }
    }
  }

  if (discovered.length === 0) {
    return {
      ok: false,
      error: "no_skills_found",
      message: `No SKILL.md found in ${repoSlug} (branch: ${effectiveBranch})`,
    };
  }

  // If only 1 skill discovered and preview is missing, fetch it now
  if (discovered.length === 1 && !discovered[0].preview) {
    const fetched = await fetchSkillMarkdown(discovered[0].rawUrl, { timeoutMs });
    if (fetched.ok && "markdown" in fetched) {
      const m = fetched.markdown;
      const mName = m.match(/^name:\s*(.+)$/m);
      const mDesc = m.match(/^description:\s*(.+)$/m);
      if (mName) {
        discovered[0].title = mName[1].trim().replace(/^["']|["']$/g, "");
        discovered[0].skillId = librarySkillDirName(mName[1]) || discovered[0].skillId;
      }
      if (mDesc) discovered[0].description = mDesc[1].trim().replace(/^["']|["']$/g, "");
      discovered[0].preview = m.slice(0, 4000);
      discovered[0].bytes = m.length;
    }
  }

  return {
    ok: true,
    type: discovered.length === 1 ? "single" : "multiple",
    repo: repoSlug,
    branch: effectiveBranch,
    skills: discovered,
  };
}

/**
 * Discover and resolve candidate skills from an input string (command, repo, or URL).
 *
 * @param {string} input
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   type?: "single" | "multiple",
 *   repo?: string,
 *   branch?: string,
 *   skills?: Array<{
 *     skillId: string,
 *     title?: string,
 *     description?: string,
 *     path?: string,
 *     rawUrl: string,
 *     preview?: string,
 *     bytes?: number
 *   }>,
 *   error?: string,
 *   message?: string
 * }>}
 */
export async function resolveSkillInput(input, opts = {}) {
  const parsed = parseSkillInput(input);
  if (parsed.type === "invalid" || !parsed) {
    return {
      ok: false,
      error: "invalid_input",
      message: parsed.error || "Invalid skill input",
    };
  }

  // 1. Direct URL path
  if (parsed.type === "direct_url" && parsed.url) {
    const fetched = await fetchSkillMarkdown(parsed.url, opts);
    if (!fetched.ok) {
      return {
        ok: false,
        error: fetched.error,
        message: fetched.message,
      };
    }
    if (fetched.notModified || !("markdown" in fetched)) {
      return { ok: false, error: "empty_content", message: "Empty skill content" };
    }

    const { markdown } = fetched;
    let title = parsed.suggestedId || "skill";
    let description = "";
    const mName = markdown.match(/^name:\s*(.+)$/m);
    const mDesc = markdown.match(/^description:\s*(.+)$/m);
    if (mName) title = mName[1].trim().replace(/^["']|["']$/g, "");
    if (mDesc) description = mDesc[1].trim().replace(/^["']|["']$/g, "");

    const skillId = librarySkillDirName(mName ? mName[1] : parsed.suggestedId) || "skill";

    return {
      ok: true,
      type: "single",
      skills: [
        {
          skillId,
          title,
          description,
          rawUrl: parsed.url,
          preview: markdown.slice(0, 4000),
          bytes: markdown.length,
        },
      ],
    };
  }

  // 2. GitHub Repo Discovery
  if (parsed.type === "github_repo" && parsed.owner && parsed.repo) {
    return findSkillsInGitHubRepo(parsed.owner, parsed.repo, parsed.branch || "main", parsed.subpath, opts);
  }

  return { ok: false, error: "unsupported", message: "Unsupported skill format" };
}
