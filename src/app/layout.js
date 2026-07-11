// @ts-check
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "material-symbols/outlined.css";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

// Match Switchboard Console standalone mock fonts
const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = {
  title: "Switchboard — Intelligent Model Routing",
  description:
    "Route every request to the right model. One OpenAI-compatible endpoint, visible routing decisions, and self-improving combos.",
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport = {
  themeColor: "#16130E",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark fonts-loaded" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable} font-sans antialiased`}>
        <ThemeProvider>
          <RuntimeI18nProvider>
            {children}
          </RuntimeI18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
