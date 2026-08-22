"use client";
// @ts-check

export default function ApiKeySelect({ value, onChange, apiKeys = [], cloudEnabled = false, className = "" }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label className="text-xs text-text-muted">Custom secret</label>
      <input
        type="password"
        value={value || ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder={cloudEnabled ? "Paste a client key secret" : "sk_switchboard (default when empty)"}
        autoComplete="off"
        className="w-full min-w-0 px-2 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
      />
      {apiKeys.length > 0 ? (
        <p className="text-[11px] text-text-muted">
          Existing prefixes (not reusable secrets): {apiKeys.map((key) => key.keyPrefix).filter(Boolean).join(", ")}
        </p>
      ) : null}
    </div>
  );
}
