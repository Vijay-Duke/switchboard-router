"use client";

import { useId } from "react";
import { cn } from "@/shared/utils/cn";

export default function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder = "Select an option",
  error,
  hint,
  disabled = false,
  required = false,
  className,
  selectClassName,
  id: idProp,
  ...props
}) {
  const autoId = useId();
  const id = idProp || autoId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-text-main">
          {label}
          {required && <span className="text-red-500 ml-1" aria-hidden="true">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
          className={cn(
            "w-full py-2.5 px-3 pr-10 text-sm text-text-main",
            "bg-surface-2 border border-transparent rounded-[10px] appearance-none",
            "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40",
            "transition-all duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed",
            "text-[16px] sm:text-sm",
            error && "ring-1 ring-red-500 focus:ring-2 focus:ring-red-500/40 border-red-500/40",
            selectClassName
          )}
          {...props}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-text-muted" aria-hidden="true">
          <span className="material-symbols-outlined text-[20px]">expand_more</span>
        </div>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p id={hintId} className="text-xs text-text-muted">{hint}</p>
      )}
    </div>
  );
}
