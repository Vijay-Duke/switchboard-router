"use client";
// @ts-check

import Link from "next/link";
import Image from "next/image";
import { Card } from "@/shared/components";

// Derive simple connected/configured/not-installed status from API payload
function getStatus(status) {
  if (!status) return { label: "Unknown", cls: "bg-gray-500/10 text-gray-500" };
  if (!status.installed) {
    return {
      label: "Not installed",
      cls: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/25",
    };
  }
  if (status.hasSwitchboard) {
    return {
      label: "Connected",
      cls: "bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20",
    };
  }
  return {
    label: "Installed · not configured",
    cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/25",
  };
}

export default function ToolSummaryCard({ toolId, tool, status }) {
  const s = getStatus(status);
  return (
    <Link href={`/dashboard/cli-tools/${toolId}`} className="block">
      <Card padding="sm" className="h-full overflow-hidden hover:border-primary/50 transition-colors cursor-pointer">
        <div className="flex h-full flex-col gap-2">
          <div className="flex items-center gap-3">
            <div className="size-8 flex items-center justify-center shrink-0">
              {tool.image ? (
                <Image src={tool.image} alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} />
              ) : tool.icon ? (
                <span className="material-symbols-outlined text-[28px]" style={{ color: tool.color }}>{tool.icon}</span>
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-medium text-sm truncate">{tool.name}</h3>
              <span className={`inline-block mt-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full ${s.cls}`}>{s.label}</span>
            </div>
            <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">chevron_right</span>
          </div>
        </div>
      </Card>
    </Link>
  );
}
