"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { getNavigation } from "@/constants/docsConfig";
import { DEFAULT_LANG } from "@/constants/languages";
import {
  BarChart3,
  BookOpen,
  Cloud,
  Code2,
  HelpCircle,
  Image,
  Layers,
  Library,
  MessageCircle,
  Monitor,
  Plug,
  Rocket,
  Terminal,
  Zap,
} from "lucide-react";

const SECTION_ICONS = {
  gettingStarted: Rocket,
  usingSwitchboard: Layers,
  clients: Plug,
  deployment: Cloud,
  help: HelpCircle,
};

const ITEM_ICONS = {
  introduction: BookOpen,
  quickStart: Rocket,
  installation: Terminal,
  endpoint: Plug,
  providers: Layers,
  combos: Layers,
  usage: BarChart3,
  tokenSaver: Zap,
  media: Image,
  skillsAgentLibrary: Library,
  cliTools: Code2,
  openaiCompatible: Plug,
  local: Monitor,
  docker: Cloud,
  troubleshooting: HelpCircle,
  faq: MessageCircle,
};

export default function DocsSidebar({ isMobile = false, onClose, lang = DEFAULT_LANG }) {
  const pathname = usePathname();
  const navigation = getNavigation(lang);
  const buildHref = (slug) => (slug ? `/${lang}/${slug}` : `/${lang}`);
  const isActive = (slug) => pathname === buildHref(slug);

  const handleLinkClick = () => {
    if (isMobile && onClose) onClose();
  };

  return (
    <aside className={isMobile ? "docs-sidebar docs-sidebar-mobile" : "docs-sidebar"}>
      <nav className="docs-sidebar-nav" aria-label="Documentation">
        {navigation.map((section) => {
          const SectionIcon = SECTION_ICONS[section.key] || BookOpen;

          return (
            <section key={section.key} className="docs-nav-section">
              <h2 className="docs-nav-heading">
                <SectionIcon className="w-4 h-4" aria-hidden="true" />
                {section.title}
              </h2>
              <ul className="docs-nav-list">
                {section.items.map((item) => {
                  const ItemIcon = ITEM_ICONS[item.key] || BookOpen;
                  const active = isActive(item.slug);

                  return (
                    <li key={item.key}>
                      <Link
                        href={buildHref(item.slug)}
                        onClick={handleLinkClick}
                        className={active ? "docs-nav-link docs-nav-link-active" : "docs-nav-link"}
                        aria-current={active ? "page" : undefined}
                      >
                        <ItemIcon className="w-4 h-4" aria-hidden="true" />
                        <span>{item.title}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </nav>
    </aside>
  );
}
