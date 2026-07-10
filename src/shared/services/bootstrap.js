import initializeApp from "./initializeApp.js";
import { isBuildPhase } from "@/lib/buildPhase.js";

// Server-only singleton: guard via global so HMR / re-imports don't double-init
if (typeof window === "undefined" && !isBuildPhase() && !global.__appBootstrapped) {
  global.__appBootstrapped = true;
  initializeApp().catch((e) => console.error("[Bootstrap] init failed:", e.message));
}
