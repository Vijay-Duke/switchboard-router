// @ts-check
"use client";

import { useEffect } from "react";

/**
 * Segment-level error boundary for all dashboard pages. Without this, any
 * client exception unmounts the whole app into Next's global error screen
 * ("This page couldn't load") with no recovery path.
 *
 * @param {{ error: Error & { digest?: string }, reset: () => void }} props
 */
export default function DashboardError({ error, reset }) {
  useEffect(() => {
    console.error("[dashboard] segment error:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 min-h-[60vh] text-center px-6">
      <span className="material-symbols-outlined text-4xl text-warning" aria-hidden="true">
        report
      </span>
      <h2 className="text-lg font-semibold">This page hit an unexpected error</h2>
      <p className="text-sm text-text-muted max-w-md break-words">
        {error?.message || "A client-side error occurred while rendering this page."}
      </p>
      <button
        type="button"
        onClick={reset}
        className="h-9 px-4 rounded-lg bg-accent hover:bg-accent/90 text-white text-sm font-medium transition-colors cursor-pointer border-none"
      >
        Try again
      </button>
    </div>
  );
}
