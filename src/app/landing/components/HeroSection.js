"use client";
// @ts-check
import { useRouter } from "next/navigation";

export default function HeroSection() {
  const router = useRouter();

  return (
    <section className="relative pt-32 pb-20 px-6 min-h-[90vh] flex flex-col items-center justify-center overflow-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-[#14b8a6]/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="relative z-10 max-w-4xl w-full text-center flex flex-col items-center gap-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#2a3444] bg-[#11161d]/60 px-3 py-1 text-xs font-medium text-[#2dd4bf] font-mono">
          <span className="flex h-2 w-2 rounded-full bg-[#2dd4bf] animate-pulse" />
          Intelligent routing · OpenAI-compatible
        </div>

        <h1 className="text-5xl md:text-7xl font-bold leading-[1.08] tracking-tight">
          Route every request
          <br />
          <span className="text-[#2dd4bf]">to the right model</span>
        </h1>

        <p className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto font-normal leading-relaxed">
          Switchboard is a local AI gateway with a dashboard. One endpoint for providers and combos,
          visible routing decisions, and self-improving Auto strategies.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-4 w-full">
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="h-12 px-8 rounded-lg bg-[#14b8a6] hover:bg-[#0d9488] text-[#0b0f14] text-base font-bold transition-all shadow-[0_0_15px_rgba(20,184,166,0.4)] flex items-center gap-2"
          >
            <span className="material-symbols-outlined">rocket_launch</span>
            Open Dashboard
          </button>
          <a
            href="#get-started"
            className="h-12 px-8 rounded-lg border border-[#2a3444] bg-[#11161d] hover:bg-[#1c2430] text-white text-base font-bold transition-all flex items-center gap-2"
          >
            <span className="material-symbols-outlined">terminal</span>
            Quick Start
          </a>
        </div>
      </div>
    </section>
  );
}
