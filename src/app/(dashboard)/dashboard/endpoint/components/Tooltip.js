"use client";
// @ts-check

import { useId } from "react";

/** Inline tooltip, Claude Code CLI style (mirrors the shared Tooltip a11y fix) */
export default function Tooltip({ text }) {
  const tipId = useId();
  return (
    <span className="relative group inline-flex items-center">
      <span
        className="material-symbols-outlined text-[14px] text-text-muted cursor-help rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        tabIndex={0}
        aria-describedby={tipId}
      >
        help
      </span>
      <span
        id={tipId}
        role="tooltip"
        className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 z-50 w-64 rounded bg-gray-900 dark:bg-gray-800 text-white text-xs px-2.5 py-1.5 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 transition-opacity shadow-lg"
      >
        {text}
      </span>
    </span>
  );
}
