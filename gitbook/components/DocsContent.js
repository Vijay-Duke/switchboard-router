"use client";

import { MarkdownRenderer } from "@/utils/markdown";

export default function DocsContent({ content }) {
  return (
    <main id="main-content" tabIndex={-1} className="docs-content">
      <article className="docs-article">
        <MarkdownRenderer content={content} />
      </article>
    </main>
  );
}
