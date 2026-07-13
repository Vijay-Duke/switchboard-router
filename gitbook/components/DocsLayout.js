"use client";

import DocsHeader from "./DocsHeader";
import DocsSidebar from "./DocsSidebar";
import DocsToc from "./DocsToc";
import { DEFAULT_LANG } from "@/constants/languages";

export default function DocsLayout({ children, headings = [], lang = DEFAULT_LANG }) {
  return (
    <div className="docs-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <DocsHeader lang={lang} />
      <div className="docs-frame">
        <div className="hidden lg:block">
          <DocsSidebar lang={lang} />
        </div>
        <div className="docs-main-column">
          {children}
          <div className="hidden xl:block">
            <DocsToc headings={headings} lang={lang} />
          </div>
        </div>
      </div>
    </div>
  );
}
