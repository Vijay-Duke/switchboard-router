"use client";
// @ts-check

import { Input } from "@/shared/components";

/** Reusable endpoint row component */
export default function EndpointRow({ label, url, copyId, copied, onCopy, badge, actions }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span
        className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 min-w-[88px] text-center border ${
          badge === "CF" || badge === "TS"
            ? "bg-primary/10 text-primary border-primary/25"
            : "bg-surface-2 text-text-muted border-border"
        }`}
      >
        {label}
      </span>
      <Input
        value={url}
        readOnly
        className="flex-1 min-w-0"
        inputClassName="font-mono text-sm"
      />
      <button
        type="button"
        onClick={() => onCopy(url, copyId)}
        className="p-2 hover:bg-surface-2 rounded text-text-muted hover:text-primary transition-colors shrink-0 border border-transparent hover:border-border"
        title="Copy"
        aria-label="Copy endpoint URL"
      >
        <span className="material-symbols-outlined text-[18px] leading-none">
          {copied === copyId ? "check" : "content_copy"}
        </span>
      </button>
      {actions}
    </div>
  );
}
