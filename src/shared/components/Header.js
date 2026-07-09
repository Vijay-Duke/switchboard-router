"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import PropTypes from "prop-types";
import ProviderIcon from "@/shared/components/ProviderIcon";
import HeaderMenu from "@/shared/components/HeaderMenu";
import HeaderLanguage from "@/shared/components/HeaderLanguage";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS } from "@/shared/constants/providers";
import { translate } from "@/i18n/runtime";

/**
 * Header matches Switchboard Console mock:
 * mono crumbs left · online + learning badges right (height 53px).
 */
const getPageInfo = (pathname) => {
  if (!pathname) return { section: "Console", crumb: "", breadcrumbs: [] };

  const mediaDetailMatch = pathname.match(/\/media-providers\/([^/]+)\/([^/]+)$/);
  if (mediaDetailMatch) {
    const kindId = mediaDetailMatch[1];
    const providerId = mediaDetailMatch[2];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    const provider = AI_PROVIDERS[providerId];
    const kindLabel =
      kindId === "web" ? "Web Fetch & Search" : kindConfig?.label || kindId;
    return {
      section: "Tools",
      crumb: provider?.name || providerId,
      breadcrumbs: [
        { label: "Media", href: "/dashboard/media-providers" },
        { label: kindLabel, href: `/dashboard/media-providers/${kindId}` },
        { label: provider?.name || providerId, image: `/providers/${providerId}.png` },
      ],
    };
  }

  if (pathname === "/dashboard/media-providers" || pathname === "/dashboard/media-providers/") {
    return { section: "Tools", crumb: "Media", breadcrumbs: [] };
  }

  const mediaKindMatch = pathname.match(/\/media-providers\/([^/]+)$/);
  if (mediaKindMatch) {
    const kindId = mediaKindMatch[1];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    const label =
      kindId === "web"
        ? "Web Fetch & Search"
        : kindConfig?.label || kindId;
    return {
      section: "Tools",
      crumb: label,
      breadcrumbs: [
        { label: "Media", href: "/dashboard/media-providers" },
        { label },
      ],
    };
  }

  const providerMatch = pathname.match(/\/providers\/([^/]+)$/);
  if (providerMatch) {
    const providerId = providerMatch[1];
    const providerInfo = OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId];
    if (providerInfo) {
      return {
        section: "Connect",
        crumb: providerInfo.name,
        breadcrumbs: [
          { label: "Providers", href: "/dashboard/providers" },
          { label: providerInfo.name, image: `/providers/${providerInfo.id}.png` },
        ],
      };
    }
  }

  if (pathname === "/dashboard") return { section: "Operate", crumb: "Overview", breadcrumbs: [] };
  if (pathname.includes("/combos")) return { section: "Operate", crumb: "Combos", breadcrumbs: [] };
  if (pathname.includes("/usage")) return { section: "Operate", crumb: "Usage", breadcrumbs: [] };
  if (pathname.includes("/quota")) return { section: "Operate", crumb: "Quota", breadcrumbs: [] };
  if (pathname.includes("/providers")) return { section: "Connect", crumb: "Providers", breadcrumbs: [] };
  if (pathname.includes("/endpoint")) return { section: "Connect", crumb: "Endpoint & keys", breadcrumbs: [] };
  if (pathname.includes("/token-saver")) return { section: "Tools", crumb: "Token saver", breadcrumbs: [] };
  if (pathname.includes("/cli-tools")) return { section: "Tools", crumb: "CLI tools", breadcrumbs: [] };
  if (pathname.includes("/agent-library")) return { section: "Tools", crumb: "Agent library", breadcrumbs: [] };
  if (pathname.includes("/skills")) return { section: "Tools", crumb: "Skills", breadcrumbs: [] };
  if (pathname.includes("/media-providers")) return { section: "Tools", crumb: "Media", breadcrumbs: [] };
  if (pathname.includes("/profile")) return { section: "Tools", crumb: "Settings", breadcrumbs: [] };
  if (pathname.includes("/translator")) return { section: "Diagnostics", crumb: "Translator", breadcrumbs: [] };
  if (pathname.includes("/console-log")) return { section: "Diagnostics", crumb: "Console", breadcrumbs: [] };
  if (pathname.includes("/mitm")) return { section: "Diagnostics", crumb: "MITM", breadcrumbs: [] };
  if (pathname.includes("/basic-chat")) return { section: "Operate", crumb: "Chat", breadcrumbs: [] };

  return { section: "Console", crumb: "", breadcrumbs: [] };
};

export default function Header({ onMenuClick, showMenuButton = true }) {
  const pathname = usePathname();
  const pageInfo = useMemo(() => getPageInfo(pathname), [pathname]);
  const { section, crumb, breadcrumbs } = pageInfo;

  return (
    <header
      className="shrink-0 z-20 flex items-center justify-between gap-4"
      style={{
        height: 53,
        flex: "0 0 53px",
        borderBottom: "1px solid #332C1E",
        background: "#1A160F",
        padding: "0 18px",
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {showMenuButton && (
          <button
            type="button"
            onClick={onMenuClick}
            className="lg:hidden text-[#A99E86] hover:text-[#E5B454]"
            aria-label="Open menu"
          >
            <span className="material-symbols-outlined text-[22px]">menu</span>
          </button>
        )}

        {breadcrumbs?.length > 0 ? (
          <div
            className="flex items-center gap-2 min-w-0 truncate"
            style={{
              fontSize: 12,
              color: "#6F6653",
              fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
            }}
          >
            {breadcrumbs.map((c, index) => (
              <span key={`${c.label}-${index}`} className="flex items-center gap-2 min-w-0">
                {index > 0 && <span style={{ color: "#4A4231" }}>/</span>}
                {c.href ? (
                  <Link href={c.href} className="hover:text-[#A99E86] truncate">
                    {translate(c.label)}
                  </Link>
                ) : (
                  <span className="flex items-center gap-2 text-[#A99E86] truncate">
                    {c.image && (
                      <ProviderIcon
                        src={c.image}
                        alt={c.label}
                        size={18}
                        className="object-contain rounded"
                        fallbackText={c.label.slice(0, 2).toUpperCase()}
                      />
                    )}
                    {translate(c.label)}
                  </span>
                )}
              </span>
            ))}
          </div>
        ) : (
          <div
            className="truncate"
            style={{
              fontSize: 12,
              color: "#6F6653",
              fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
            }}
          >
            {section}
            {crumb ? (
              <>
                {" "}
                <span style={{ color: "#4A4231" }}>/</span>{" "}
                <span style={{ color: "#A99E86" }}>{translate(crumb)}</span>
              </>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex items-center gap-[9px] shrink-0">
        <HeaderSearch />

        {/* online badge — mock */}
        <div
          className="hidden sm:flex items-center gap-[7px]"
          style={{
            background: "#211C14",
            border: "1px solid #2A2418",
            borderRadius: 7,
            padding: "5px 10px",
          }}
        >
          <span className="console-online-dot" />
          <span
            style={{
              fontSize: 11.5,
              fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
              color: "#A99E86",
            }}
          >
            online
          </span>
        </div>

        {/* Local gateway badge — not a fake "learning auto" claim */}
        <div
          className="hidden md:flex items-center gap-[7px]"
          style={{
            background: "rgba(229,180,84,.1)",
            border: "1px solid rgba(229,180,84,.3)",
            borderRadius: 7,
            padding: "5px 10px",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 2,
              background: "#E5B454",
            }}
          />
          <span
            style={{
              fontSize: 11.5,
              fontFamily: "var(--font-mono), 'IBM Plex Mono', monospace",
              color: "#E5B454",
              whiteSpace: "nowrap",
            }}
          >
            local gateway
          </span>
        </div>

        <HeaderLanguage />
        <HeaderMenu />
      </div>
    </header>
  );
}

function HeaderSearch() {
  const visible = useHeaderSearchStore((s) => s.visible);
  const query = useHeaderSearchStore((s) => s.query);
  const placeholder = useHeaderSearchStore((s) => s.placeholder);
  const setQuery = useHeaderSearchStore((s) => s.setQuery);

  if (!visible) return null;

  return (
    <div className="relative w-[140px] sm:w-[200px]">
      <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[#6F6653] text-[16px] pointer-events-none">
        search
      </span>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full h-8 pl-7 pr-7 rounded-[7px] border border-[#2A2418] bg-[#211C14] text-[12px] font-mono text-[#A99E86] focus:outline-none focus:border-[#E5B454]/50"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-[#6F6653] hover:text-[#ECE4D2] p-0.5 rounded"
          aria-label="Clear search"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      )}
    </div>
  );
}

Header.propTypes = {
  onMenuClick: PropTypes.func,
  showMenuButton: PropTypes.bool,
};
