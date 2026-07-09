"use client";
// @ts-check
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const router = useRouter();

  return (
    <nav className="fixed top-0 z-50 w-full bg-[#0b0f14]/85 backdrop-blur-md border-b border-[#2a3444]">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <button
          type="button"
          className="flex items-center gap-3 cursor-pointer bg-transparent border-none p-0"
          onClick={() => router.push("/")}
          aria-label="Navigate to home"
        >
          <div className="size-8 rounded-lg bg-linear-to-br from-[#2dd4bf] to-[#0f766e] flex items-center justify-center text-white ring-1 ring-[#2dd4bf]/30">
            <span className="material-symbols-outlined text-[18px]">account_tree</span>
          </div>
          <h2 className="text-white text-xl font-semibold tracking-tight">Switchboard</h2>
        </button>

        <div className="hidden md:flex items-center gap-8">
          <a className="text-gray-300 hover:text-white text-sm font-medium transition-colors" href="#features">Features</a>
          <a className="text-gray-300 hover:text-white text-sm font-medium transition-colors" href="#how-it-works">How it Works</a>
          <a className="text-gray-300 hover:text-white text-sm font-medium transition-colors" href="#get-started">Get Started</a>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push("/dashboard")}
            className="hidden sm:flex h-9 items-center justify-center rounded-lg px-4 bg-[#14b8a6] hover:bg-[#0d9488] transition-all text-[#0b0f14] text-sm font-bold shadow-[0_0_15px_rgba(20,184,166,0.35)] hover:shadow-[0_0_20px_rgba(20,184,166,0.5)]"
          >
            Open Dashboard
          </button>
          <button
            className="md:hidden text-white p-1"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle menu"
          >
            <span className="material-symbols-outlined">{mobileMenuOpen ? "close" : "menu"}</span>
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="md:hidden border-t border-[#2a3444] bg-[#0b0f14]/95 px-6 py-4 flex flex-col gap-3">
          <a className="text-gray-300 hover:text-white text-sm font-medium" href="#features" onClick={() => setMobileMenuOpen(false)}>Features</a>
          <a className="text-gray-300 hover:text-white text-sm font-medium" href="#how-it-works" onClick={() => setMobileMenuOpen(false)}>How it Works</a>
          <a className="text-gray-300 hover:text-white text-sm font-medium" href="#get-started" onClick={() => setMobileMenuOpen(false)}>Get Started</a>
          <button
            onClick={() => router.push("/dashboard")}
            className="h-9 rounded-lg bg-[#14b8a6] hover:bg-[#0d9488] text-[#0b0f14] text-sm font-bold"
          >
            Open Dashboard
          </button>
        </div>
      )}
    </nav>
  );
}
