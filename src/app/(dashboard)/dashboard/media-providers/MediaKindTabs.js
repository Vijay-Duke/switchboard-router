"use client";
// @ts-check

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";

/** Sub-tabs for media modalities (not Skills — those are a separate route). */
const TABS = [
  { id: "image", label: "Image", href: "/dashboard/media-providers/image" },
  { id: "tts", label: "TTS", href: "/dashboard/media-providers/tts" },
  { id: "stt", label: "STT", href: "/dashboard/media-providers/stt" },
  { id: "embedding", label: "Embedding", href: "/dashboard/media-providers/embedding" },
  { id: "web", label: "Web", href: "/dashboard/media-providers/web" },
];

/**
 * @param {{ activeKind?: string }} props
 */
export default function MediaKindTabs({ activeKind }) {
  const pathname = usePathname();
  const current =
    activeKind ||
    TABS.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))?.id ||
    "";

  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-5">
      <Link
        href="/dashboard/media-providers"
        className={cn(
          "px-2.5 py-1 rounded-[7px] text-xs font-medium border transition-colors",
          pathname === "/dashboard/media-providers"
            ? "bg-brand-500/15 text-primary border-brand-500/40"
            : "bg-transparent text-text-muted border-border hover:text-text-main hover:border-brand-500/30"
        )}
      >
        All
      </Link>
      {TABS.map((tab) => {
        const active = current === tab.id;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            className={cn(
              "px-2.5 py-1 rounded-[7px] text-xs font-medium border transition-colors",
              active
                ? "bg-brand-500/15 text-primary border-brand-500/40"
                : "bg-transparent text-text-muted border-border hover:text-text-main hover:border-brand-500/30"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
