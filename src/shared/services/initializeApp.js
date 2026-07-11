// M11: open-sse reads persistence through injected deps. The SSE request
// handlers wire them, but the scheduler + quota ping start before any request
// arrives — without this they would silently run against the no-op defaults.
import "@/sse/initOpenSseDeps.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { cleanupProviderConnections, getSettings, updateSettings, getApiKeys, deleteOldRoutingEvents } from "@/lib/db/index.js";
import { getMitmStatus, startMitm, loadEncryptedPassword, initDbHooks, restoreToolDNS, removeAllDNSEntriesSync } from "@/mitm/manager";
import { startQuotaAutoPing } from "@/shared/services/quotaAutoPing";
import { startAutoLearnScheduler } from "open-sse/routing/scheduler.js";
import { syncToJson as syncMitmAliasCache } from "@/lib/mitmAliasCache";
import { closeAdapter } from "@/lib/db/driver.js";
import { flushPendingRequestDetails } from "@/lib/db/repos/requestDetailsRepo.js";

const ROUTING_RETENTION_DAYS = 90;
const ROUTING_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Inject correct paths and DB hooks into manager.js (CJS) from ESM context
(function bootstrapMitm() {
  if (!process.env.MITM_SERVER_PATH) {
    try {
      const thisFile = fileURLToPath(import.meta.url);
      const appSrc = dirname(dirname(thisFile));
      const candidate = join(appSrc, "mitm", "server.js");
      if (existsSync(candidate)) process.env.MITM_SERVER_PATH = candidate;
    } catch { /* ignore */ }
  }
  try { initDbHooks(getSettings, updateSettings); } catch { /* ignore */ }
})();

process.setMaxListeners(20);

// Survive Next.js hot reload
const g = global.__appSingleton ??= {
  signalHandlersRegistered: false,
  mitmStartInProgress: false,
  routingRetentionTimer: null,
  shuttingDown: false,
};

export function registerShutdownHandlers() {
  if (g.signalHandlersRegistered) return;

  const cleanup = async () => {
    if (g.shuttingDown) return;
    g.shuttingDown = true;
    const forceExit = setTimeout(() => process.exit(1), 1800);
    forceExit.unref?.();
    try { await flushPendingRequestDetails(); } catch { /* best effort */ }
    try { await closeAdapter(); } catch { /* best effort */ }
    try { removeAllDNSEntriesSync(); } catch { /* best effort */ }
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", () => { try { removeAllDNSEntriesSync(); } catch { /* ignore */ } });
  g.signalHandlersRegistered = true;
}

export async function initializeApp() {
  try {
    // Keep direct/non-Next bootstrap callers safe; instrumentation registers this
    // before initialization, and the global guard makes the operation idempotent.
    registerShutdownHandlers();
    await cleanupProviderConnections();

    // Sync mitmAlias DB → JSON cache so standalone MITM server can read it
    syncMitmAliasCache().catch(() => {});

    autoStartMitm();
    startQuotaAutoPing();
    startRoutingEventRetention();
    try {
      startAutoLearnScheduler({
        log: {
          info: (...a) => console.log(...a),
          warn: (...a) => console.warn(...a),
          error: (...a) => console.error(...a),
        },
      });
    } catch (e) {
      console.warn("[InitApp] auto-learn scheduler failed to start:", e?.message || e);
    }
  } catch (error) {
    console.error("[InitApp] Error:", error);
  }
}

/** Daily purge of routing_events older than ROUTING_RETENTION_DAYS (default 90). */
function startRoutingEventRetention() {
  if (g.routingRetentionTimer) return;
  const run = () => {
    deleteOldRoutingEvents(ROUTING_RETENTION_DAYS)
      .then((n) => {
        if (n > 0) console.log(`[InitApp] Purged ${n} routing_events older than ${ROUTING_RETENTION_DAYS}d`);
      })
      .catch((e) => console.warn("[InitApp] routing retention failed:", e?.message || e));
  };
  // Run shortly after boot, then daily
  setTimeout(run, 30_000);
  g.routingRetentionTimer = setInterval(run, ROUTING_RETENTION_INTERVAL_MS);
  // Don't keep process alive solely for retention
  if (typeof g.routingRetentionTimer.unref === "function") g.routingRetentionTimer.unref();
}

async function autoStartMitm() {
  if (g.mitmStartInProgress) return;
  g.mitmStartInProgress = true;
  try {
    const settings = await getSettings();
    if (!settings.mitmEnabled) return;
    const mitmStatus = await getMitmStatus();
    if (mitmStatus.running) return;

    const password = await loadEncryptedPassword();
    if (!password && process.platform !== "win32") {
      console.log("[InitApp] MITM was enabled but no saved password found, skipping auto-start");
      return;
    }

    const keys = await getApiKeys();
    const activeKey = keys.find((k) => k.isActive !== false);

    console.log("[InitApp] MITM was enabled, auto-starting...");
    await startMitm(activeKey?.key || "sk_switchboard", password);
    console.log("[InitApp] MITM auto-started");
    try {
      await restoreToolDNS(password);
      console.log("[InitApp] DNS restored from saved state");
    } catch (e) {
      console.log("[InitApp] DNS restore failed:", e.message);
    }
  } catch (err) {
    console.log("[InitApp] MITM auto-start failed:", err.message);
  } finally {
    g.mitmStartInProgress = false;
  }
}

export default initializeApp;
