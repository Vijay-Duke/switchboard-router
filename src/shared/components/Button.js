"use client";

import { cn } from "@/shared/utils/cn";

/**
 * Primary uses amber fill + dark ink (console mock). Never pair gold with white.
 */
const variants = {
  primary:
    "bg-brand-500 hover:bg-brand-400 text-[#1B1710] border border-brand-500/80 shadow-sm disabled:bg-surface-3 disabled:text-text-muted disabled:border-transparent",
  secondary:
    "bg-surface-2 hover:bg-surface-3 text-text-main border border-border disabled:opacity-50",
  outline:
    "border border-border text-text-main hover:bg-surface-2 hover:border-brand-500/40 bg-transparent",
  ghost: "text-text-muted hover:bg-surface-2 hover:text-text-main border border-transparent",
  danger:
    "bg-red-500 hover:bg-red-600 text-white shadow-sm disabled:bg-surface-3 disabled:text-text-muted",
  success:
    "bg-green-600 hover:bg-green-700 text-white shadow-sm disabled:bg-surface-3 disabled:text-text-muted",
};

const sizes = {
  sm: "h-8 px-3 text-xs rounded-[7px]",
  md: "h-9 px-3.5 text-sm rounded-[8px]",
  lg: "h-11 px-5 text-sm rounded-[10px]",
};

export default function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  disabled = false,
  loading = false,
  fullWidth = false,
  className,
  ...props
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-semibold transition-all duration-150 ease-out cursor-pointer",
        "active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100",
        variants[variant],
        sizes[size],
        fullWidth && "w-full",
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span
          className="material-symbols-outlined leading-none animate-spin shrink-0"
          style={{ fontSize: 18 }}
        >
          progress_activity
        </span>
      ) : icon ? (
        <span
          className="material-symbols-outlined leading-none shrink-0"
          style={{ fontSize: 18 }}
        >
          {icon}
        </span>
      ) : null}
      {children ? <span className="leading-none">{children}</span> : null}
      {iconRight && !loading ? (
        <span
          className="material-symbols-outlined leading-none shrink-0"
          style={{ fontSize: 18 }}
        >
          {iconRight}
        </span>
      ) : null}
    </button>
  );
}
