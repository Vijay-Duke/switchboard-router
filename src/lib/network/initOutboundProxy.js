import { getSettings } from "@/lib/db/index.js";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { isBuildPhase } from "@/lib/buildPhase.js";

let initialized = false;

export async function ensureOutboundProxyInitialized() {
  if (initialized) return true;

  try {
    const settings = await getSettings();
    applyOutboundProxyEnv(settings);
    initialized = true;
  } catch (error) {
    console.error("[ServerInit] Error initializing outbound proxy:", error);
  }

  return initialized;
}

// Defer init so HTTP server accepts connections first. Never during `next build` —
// it would open (and migrate) the operator's live database.
if (!isBuildPhase()) {
  setImmediate(() => {
    ensureOutboundProxyInitialized().catch(console.log);
  });
}

export default ensureOutboundProxyInitialized;
