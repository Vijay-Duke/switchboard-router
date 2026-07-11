import { isBuildPhase } from "@/lib/buildPhase.js";

/**
 * Initialize process-wide services before Next starts serving requests.
 *
 * Keep the promise on global so development hot reloads and concurrent calls
 * share one bootstrap and cannot install duplicate signal handlers.
 */
export async function register() {
  // instrumentation.js can be compiled for both runtimes. The app bootstrap
  // imports Node-only persistence and process APIs, so never load it on Edge.
  if (process.env.NEXT_RUNTIME === "edge" || isBuildPhase()) return;

  if (!global.__appInstrumentationRegistration) {
    const registration = (async () => {
      const { registerShutdownHandlers, initializeApp } = await import(
        "./shared/services/initializeApp.js"
      );

      registerShutdownHandlers();
      if (global.__appBootstrapped) return;

      global.__appBootstrapped = true;
      await initializeApp();
    })();

    global.__appInstrumentationRegistration = registration.catch((error) => {
      console.error("[Instrumentation] bootstrap failed:", error?.message || error);
    });
  }

  await global.__appInstrumentationRegistration;
}
