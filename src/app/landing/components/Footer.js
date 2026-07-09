"use client";
// @ts-check
import { useRouter } from "next/navigation";

export default function Footer() {
  const router = useRouter();
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-[#2a3444] bg-[#0b0f14]/80">
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mb-10">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="size-6 rounded bg-linear-to-br from-[#2dd4bf] to-[#0f766e] flex items-center justify-center text-white">
                <span className="material-symbols-outlined text-[14px]">account_tree</span>
              </div>
              <h3 className="text-white text-lg font-semibold">Switchboard</h3>
            </div>
            <p className="text-gray-500 text-sm leading-relaxed max-w-xs">
              Intelligent model routing for AI coding tools. One endpoint, visible decisions, self-improving combos.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Product</p>
            <a className="text-gray-400 hover:text-[#2dd4bf] text-sm transition-colors" href="#features">Features</a>
            <a className="text-gray-400 hover:text-[#2dd4bf] text-sm transition-colors" href="#how-it-works">How it Works</a>
            <button
              type="button"
              className="text-left text-gray-400 hover:text-[#2dd4bf] text-sm transition-colors bg-transparent border-none p-0 cursor-pointer"
              onClick={() => router.push("/dashboard")}
            >
              Dashboard
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Resources</p>
            <a className="text-gray-400 hover:text-[#2dd4bf] text-sm transition-colors" href="#get-started">Quick Start</a>
            <a className="text-gray-400 hover:text-[#2dd4bf] text-sm transition-colors" href="/SWITCHBOARD.md">Direction</a>
          </div>
        </div>

        <div className="pt-6 border-t border-[#2a3444] flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-gray-600 text-sm">© {year} Switchboard. Local, open infrastructure.</p>
        </div>
      </div>
    </footer>
  );
}
