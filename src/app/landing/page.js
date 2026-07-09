"use client";
// @ts-check
import { useRouter } from "next/navigation";
import Navigation from "./components/Navigation";
import HeroSection from "./components/HeroSection";
import FlowAnimation from "./components/FlowAnimation";
import HowItWorks from "./components/HowItWorks";
import Features from "./components/Features";
import GetStarted from "./components/GetStarted";
import Footer from "./components/Footer";

export default function LandingPage() {
  const router = useRouter();
  return (
    <div className="relative text-white font-sans overflow-x-hidden antialiased selection:bg-[#14b8a6] selection:text-[#0b0f14]">
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none bg-[#0b0f14]">
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage: `linear-gradient(to right, #14b8a6 1px, transparent 1px), linear-gradient(to bottom, #14b8a6 1px, transparent 1px)`,
            backgroundSize: "50px 50px",
          }}
        />
        <div className="absolute top-0 left-1/4 w-[700px] h-[700px] bg-[#14b8a6]/12 rounded-full blur-[130px] animate-blob" />
        <div
          className="absolute top-1/3 right-1/4 w-[600px] h-[600px] bg-cyan-500/8 rounded-full blur-[130px] animate-blob"
          style={{ animationDelay: "2s", animationDuration: "22s" }}
        />
        <div
          className="absolute bottom-0 left-1/2 w-[650px] h-[650px] bg-teal-600/8 rounded-full blur-[130px] animate-blob"
          style={{ animationDelay: "4s", animationDuration: "25s" }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at center, transparent 0%, rgba(11, 15, 20, 0.55) 100%)",
          }}
        />
      </div>

      <div className="relative z-10">
        <Navigation />

        <main>
          <div className="relative">
            <HeroSection />
            <div className="flex justify-center pb-20">
              <FlowAnimation />
            </div>
          </div>

          <GetStarted />
          <HowItWorks />
          <Features />

          <section className="py-32 px-6 relative overflow-hidden">
            <div className="absolute inset-0 bg-linear-to-t from-[#14b8a6]/5 to-transparent pointer-events-none" />
            <div className="max-w-4xl mx-auto text-center relative z-10">
              <h2 className="text-4xl md:text-5xl font-bold mb-6 tracking-tight">
                Put a crossbar in front of your models
              </h2>
              <p className="text-xl text-gray-400 mb-10 max-w-2xl mx-auto">
                Connect providers once. Route with combos. Learn which model wins for your workload.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <button
                  onClick={() => router.push("/dashboard")}
                  className="w-full sm:w-auto h-14 px-10 rounded-lg bg-[#14b8a6] hover:bg-[#0d9488] text-[#0b0f14] text-lg font-bold transition-all shadow-[0_0_20px_rgba(20,184,166,0.45)]"
                >
                  Open Dashboard
                </button>
                <a
                  href="#get-started"
                  className="w-full sm:w-auto h-14 px-10 rounded-lg border border-[#2a3444] hover:bg-[#11161d] text-white text-lg font-bold transition-all inline-flex items-center justify-center"
                >
                  Install locally
                </a>
              </div>
            </div>
          </section>
        </main>

        <Footer />
      </div>

      <style jsx global>{`
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
        @keyframes dash {
          to { stroke-dashoffset: -20; }
        }
        @keyframes blob {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(30px, -50px) scale(1.1); }
          66% { transform: translate(-20px, 20px) scale(0.9); }
        }
        .animate-blob {
          animation: blob 20s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
