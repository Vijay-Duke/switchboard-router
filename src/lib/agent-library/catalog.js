// @ts-check
import { installSkillMarkdown } from "./skills-store.js";
import { librarySkillDirName } from "./paths.js";
import dns from "node:dns/promises";
import net from "node:net";

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
async function assertSafeCatalogUrl(urlStr) {
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
 * @param {string} libraryRoot
 * @param {{
 *   skillId: string,
 *   url: string,
 *   confirmed: boolean,
 *   requireConfirm: boolean,
 * }} args
 */
export async function installFromUrl(libraryRoot, args) {
  if (args.requireConfirm && !args.confirmed) {
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

  const safe = await assertSafeCatalogUrl(args.url);
  if (!safe.ok) return safe;

  let res;
  try {
    res = await fetch(safe.url.toString(), {
      headers: { Accept: "text/plain, text/markdown, */*" },
      signal: AbortSignal.timeout(30_000),
      redirect: "error", // no open redirects to private hosts
    });
  } catch (e) {
    return {
      ok: false,
      error: "fetch_failed",
      message: e?.message || "Failed to fetch skill",
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: "http_error",
      message: `HTTP ${res.status} fetching skill`,
    };
  }

  const markdown = await res.text();
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

  const installed = await installSkillMarkdown(libraryRoot, {
    id: skillId,
    markdown,
    source: `url:${args.url}`,
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
