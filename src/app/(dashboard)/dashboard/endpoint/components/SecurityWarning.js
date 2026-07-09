"use client";
// @ts-check

/** Security warning banner with optional action link */
export default function SecurityWarning({ message, action }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-500/10 border border-brand-500/30 text-brand-400">
      <span className="material-symbols-outlined text-[16px] shrink-0 leading-none">warning</span>
      <p className="text-xs flex-1 text-brand-300">{message}</p>
      {action && (
        <a
          href={action.href}
          className="text-xs font-medium underline shrink-0 hover:opacity-80"
          onClick={action.href.startsWith("#") ? (e) => {
            e.preventDefault();
            document.getElementById(action.href.slice(1))?.scrollIntoView({ behavior: "smooth" });
          } : undefined}
        >
          {action.label}
        </a>
      )}
    </div>
  );
}
