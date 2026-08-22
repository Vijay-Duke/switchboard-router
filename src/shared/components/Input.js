"use client";

import { useId } from "react";
import { cn } from "@/shared/utils/cn";

export default function Input({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
  hint,
  icon,
  disabled = false,
  required = false,
  className,
  inputClassName,
  id: idProp,
  ...props
}) {
  const autoId = useId();
  const id = idProp || autoId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className={cn("flex flex-col gap-1.5 min-w-0", className)}>
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-text-main">
          {label}
          {required && <span className="text-red-500 ml-1" aria-hidden="true">*</span>}
        </label>
      )}
      <div className="relative min-w-0">
        {icon && (
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-text-muted" aria-hidden="true">
            <span className="material-symbols-outlined text-[20px] leading-none">{icon}</span>
          </div>
        )}
        <input
          id={id}
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
          className={cn(
            "w-full min-w-0 py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-[8px]",
            "border border-border placeholder:text-text-subtle",
            "focus:outline-none focus:ring-2 focus:ring-brand-500/25 focus:border-brand-500/50",
            "transition-all duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed",
            // iOS zoom fix
            "text-[16px] sm:text-sm",
            icon && "pl-10",
            error && "ring-1 ring-red-500 focus:ring-2 focus:ring-red-500/40 border-red-500/40",
            inputClassName
          )}
          {...props}
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px] leading-none" aria-hidden="true">error</span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p id={hintId} className="text-xs text-text-muted">{hint}</p>
      )}
    </div>
  );
}
