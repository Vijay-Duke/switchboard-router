"use client";

import { useId } from "react";
import { cn } from "@/shared/utils/cn";
import { useDialog } from "@/shared/hooks/useDialog";

export default function Drawer({
  isOpen,
  onClose,
  title,
  children,
  width = "md",
  className,
  "aria-label": ariaLabel,
}) {
  const widths = {
    sm: "w-[400px]",
    md: "w-[500px]",
    lg: "w-[600px]",
    xl: "w-[800px]",
    full: "w-full",
  };

  // Dialog semantics: focus trap, Escape close, focus return (useDialog),
  // plus role/aria wiring so every consumer inherits dialog behavior.
  const dialogRef = useDialog({ isOpen, onClose });
  const titleId = useId();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px] fade-in cursor-pointer"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          "absolute right-0 top-0 h-full bg-surface flex flex-col",
          "shadow-[var(--shadow-elev)]",
          "slide-in-right",
          "border-l border-border-subtle",
          "outline-none",
          widths[width] || widths.md,
          className
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-3">
            {title && (
              <h2 id={titleId} className="text-lg font-semibold text-text-main">{title}</h2>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-[10px] text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {children}
        </div>
      </div>
    </div>
  );
}
