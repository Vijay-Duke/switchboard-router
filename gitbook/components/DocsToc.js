"use client";

import { useEffect, useState } from "react";
import { List } from "lucide-react";
import { t } from "@/constants/docsConfig";
import { DEFAULT_LANG } from "@/constants/languages";

export default function DocsToc({ headings, lang = DEFAULT_LANG }) {
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      { rootMargin: "-80px 0px -80% 0px" }
    );

    headings.forEach(({ id }) => {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    });

    return () => observer.disconnect();
  }, [headings]);

  if (!headings || headings.length === 0) return null;

  return (
    <aside className="docs-toc">
      <nav className="docs-toc-nav" aria-label={t(lang, "onThisPage")}>
        <h2 className="docs-toc-heading">
          <List className="w-4 h-4" aria-hidden="true" />
          {t(lang, "onThisPage")}
        </h2>
        <ul className="docs-toc-list">
          {headings.map((heading, idx) => (
            <li key={`${heading.id}-${idx}`}>
              <a
                href={`#${heading.id}`}
                className={`docs-toc-link ${heading.level === 3 ? "docs-toc-link-nested" : ""} ${
                  activeId === heading.id
                    ? "docs-toc-link-active"
                    : ""
                }`}
              >
                {heading.text}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
