import { describe, expect, it } from "vitest";
import { renderSafeMarkdown, renderSkillMarkdown } from "../../src/lib/skills/markdown.js";

describe("markdown HTML boundary", () => {
  it("drops raw HTML and unsafe links while keeping normal markdown", () => {
    const html = renderSafeMarkdown([
      "# Safe heading",
      '<img src=x onerror="alert(1)">',
      '<script>alert(1)</script>',
      "[bad](javascript:alert(1))",
      "[good](https://example.com)",
    ].join("\n\n"));

    expect(html).toContain("Safe heading");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toMatch(/script|onerror|javascript:/i);
  });

  it("still strips skill frontmatter before rendering", () => {
    const result = renderSkillMarkdown("---\nname: demo\n---\n# Body");
    expect(result.meta.name).toBe("demo");
    expect(result.html).toContain("Body");
    expect(result.html).not.toContain("name: demo");
  });
});
