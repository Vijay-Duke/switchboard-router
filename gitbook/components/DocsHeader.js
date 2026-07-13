"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { DOCS_CONFIG, t } from "@/constants/docsConfig";
import { DEFAULT_LANG } from "@/constants/languages";
import { ExternalLink, Menu, X } from "lucide-react";
import DocsSidebar from "./DocsSidebar";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export default function DocsHeader({ lang = DEFAULT_LANG }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuButtonRef = useRef(null);
  const drawerRef = useRef(null);

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const previousOverflow = document.body.style.overflow;
    const drawer = drawerRef.current;
    const focusable = drawer?.querySelectorAll(
      'button, [href], [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable?.[0];
    const last = focusable?.[focusable.length - 1];

    document.body.style.overflow = "hidden";
    first?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
        return;
      }
      if (event.key !== "Tab" || !first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      menuButtonRef.current?.focus();
    };
  }, [mobileMenuOpen]);

  return (
    <>
      <header className="docs-header">
        <div className="docs-header-inner">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="docs-icon-button docs-mobile-menu-trigger"
            aria-label="Open menu"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-docs-navigation"
          >
            <Menu className="w-5 h-5" aria-hidden="true" />
          </button>

          <Link
            href={`/${lang}`}
            className="docs-brand"
            aria-label="Switchboard documentation home"
          >
            <img
              className="docs-brand-icon"
              src={`${basePath}/favicon.svg`}
              alt=""
              width={32}
              height={32}
            />
            <span>{DOCS_CONFIG.logo}</span>
            <span className="docs-brand-suffix">Docs</span>
          </Link>

          <a
            href={DOCS_CONFIG.appUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="docs-app-link"
            aria-label={`${t(lang, "goToApp")} (opens in a new tab)`}
          >
            <span className="hidden sm:inline">{t(lang, "goToApp")}</span>
            <ExternalLink className="w-4 h-4" aria-hidden="true" />
          </a>
        </div>
      </header>

      {mobileMenuOpen && (
        <>
          <button
            type="button"
            className="mobile-menu-overlay lg:hidden"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close menu"
          />
          <aside
            ref={drawerRef}
            id="mobile-docs-navigation"
            className="mobile-menu-drawer lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-docs-title"
          >
            <div className="mobile-menu-heading">
              <span id="mobile-docs-title" className="docs-brand docs-brand-mobile">
                <img
                  className="docs-brand-icon"
                  src={`${basePath}/favicon.svg`}
                  alt=""
                  width={32}
                  height={32}
                />
                {DOCS_CONFIG.logo} Docs
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="docs-icon-button"
                aria-label="Close menu"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <DocsSidebar isMobile onClose={() => setMobileMenuOpen(false)} lang={lang} />
          </aside>
        </>
      )}
    </>
  );
}
