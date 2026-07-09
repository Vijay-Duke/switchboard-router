"use client";

import { cn } from "@/shared/utils/cn";

export default function Toggle({
  checked = false,
  onChange,
  label,
  description,
  disabled = false,
  size = "md",
  className,
  title,
}) {
  const sizes = {
    sm: { track: "w-8 h-4", thumb: "size-3", on: "translate-x-4", off: "translate-x-0.5" },
    md: { track: "w-11 h-6", thumb: "size-5", on: "translate-x-5", off: "translate-x-0.5" },
    lg: { track: "w-14 h-7", thumb: "size-6", on: "translate-x-7", off: "translate-x-0.5" },
  };
  const s = sizes[size] || sizes.md;

  const handleClick = () => {
    if (!disabled && onChange) onChange(!checked);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-3",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        title={title}
        disabled={disabled}
        onClick={handleClick}
        className={cn(
          "relative inline-flex shrink-0 cursor-pointer items-center rounded-full",
          "transition-colors duration-200 ease-in-out",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/35",
          // Unchecked track must be clearly off (bordered), not near-black void
          checked ? "bg-brand-500" : "bg-surface-3 border border-border",
          s.track,
          disabled && "cursor-not-allowed"
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-block rounded-full shadow-sm",
            // Dark ink thumb on amber when on; cream thumb when off
            checked ? "bg-[#1B1710]" : "bg-[#ECE4D2]",
            "transform transition duration-200 ease-in-out",
            checked ? s.on : s.off,
            s.thumb,
            "mt-0.5"
          )}
        />
      </button>
      {(label || description) && (
        <div className="flex flex-col min-w-0">
          {label && (
            <span className="text-sm font-medium text-text-main">{label}</span>
          )}
          {description && (
            <span className="text-xs text-text-muted">{description}</span>
          )}
        </div>
      )}
    </div>
  );
}
