// @ts-check
/**
 * Client-safe skill markdown helpers (no Node fs).
 */
import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: false,
  pedantic: false,
});

/**
 * Strip YAML frontmatter and return { meta, body }.
 * @param {string} md
 * @returns {{ meta: Record<string, string>, body: string }}
 */
export function splitSkillFrontmatter(md) {
  const text = String(md || "");
  if (!text.startsWith("---")) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { meta: {}, body: text };
  }
  const yaml = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    meta[m[1]] = v;
  }
  return { meta, body };
}

/**
 * Render skill markdown to HTML (strips frontmatter first).
 * @param {string} md
 * @returns {{ html: string, meta: Record<string, string>, body: string }}
 */
export function renderSkillMarkdown(md) {
  const { meta, body } = splitSkillFrontmatter(md);
  const html = /** @type {string} */ (marked.parse(body, { async: false }));
  return { html, meta, body };
}
