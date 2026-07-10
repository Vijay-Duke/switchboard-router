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

function escapeAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isSafeMarkdownUrl(value) {
  const url = String(value || "").trim();
  if (!url) return false;
  if (/^(https?:|mailto:)/i.test(url)) return true;
  return /^(\/|\.\/|\.\.\/|#)/.test(url);
}

// Markdown is rendered into dangerouslySetInnerHTML by the dashboard. Raw HTML
// is not needed for skill/changelog content, so drop it at the parser boundary
// and explicitly allow-list link/image URL schemes.
marked.use({
  renderer: {
    html: () => "",
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (!isSafeMarkdownUrl(href)) return text;
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
      return `<a href="${escapeAttribute(href)}"${titleAttr}>${text}</a>`;
    },
    image({ href, title, text }) {
      if (!isSafeMarkdownUrl(href) || /^mailto:/i.test(href)) return escapeAttribute(text);
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
      return `<img src="${escapeAttribute(href)}" alt="${escapeAttribute(text)}"${titleAttr}>`;
    },
  },
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
  const html = renderSafeMarkdown(body);
  return { html, meta, body };
}

/**
 * Render untrusted markdown without allowing embedded HTML.
 * @param {string} md
 * @returns {string}
 */
export function renderSafeMarkdown(md) {
  return /** @type {string} */ (marked.parse(String(md || ""), { async: false }));
}
