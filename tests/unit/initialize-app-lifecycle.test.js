import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanupProviderConnections: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getApiKeys: vi.fn(),
  deleteOldRoutingEvents: vi.fn(),
  initDbHooks: vi.fn(),
  removeAllDNSEntriesSync: vi.fn(),
  flushPendingRequestDetails: vi.fn().mockResolvedValue(undefined),
  closeAdapter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/sse/initOpenSseDeps.js", () => ({}));
vi.mock("@/lib/db/index.js", () => ({
  cleanupProviderConnections: mocks.cleanupProviderConnections,
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
  getApiKeys: mocks.getApiKeys,
  deleteOldRoutingEvents: mocks.deleteOldRoutingEvents,
}));
vi.mock("@/mitm/manager", () => ({
  getMitmStatus: vi.fn(),
  startMitm: vi.fn(),
  loadEncryptedPassword: vi.fn(),
  initDbHooks: mocks.initDbHooks,
  restoreToolDNS: vi.fn(),
  removeAllDNSEntriesSync: mocks.removeAllDNSEntriesSync,
}));
vi.mock("@/shared/services/quotaAutoPing", () => ({ startQuotaAutoPing: vi.fn() }));
vi.mock("open-sse/routing/scheduler.js", () => ({ startAutoLearnScheduler: vi.fn() }));
vi.mock("@/lib/mitmAliasCache", () => ({ syncToJson: vi.fn() }));
vi.mock("@/lib/db/driver.js", () => ({ closeAdapter: mocks.closeAdapter }));
vi.mock("@/lib/db/repos/requestDetailsRepo.js", () => ({
  flushPendingRequestDetails: mocks.flushPendingRequestDetails,
}));

const trackedSignals = ["SIGINT", "SIGTERM", "exit"];
let baselineListeners;

beforeEach(() => {
  baselineListeners = new Map(
    trackedSignals.map((signal) => [signal, new Set(process.listeners(signal))])
  );
  delete global.__appSingleton;
  delete global.__appBootstrapped;
  delete global.__appInstrumentationRegistration;
});

afterEach(() => {
  for (const signal of trackedSignals) {
    const baseline = baselineListeners.get(signal);
    for (const listener of process.listeners(signal)) {
      if (!baseline.has(listener)) process.off(signal, listener);
    }
  }
  delete global.__appSingleton;
  delete global.__appBootstrapped;
  delete global.__appInstrumentationRegistration;
  vi.restoreAllMocks();
});

describe("initializeApp shutdown registration", () => {
  it("lets instrumentation install handlers before any layout render", async () => {
    // Skip app initialization here so this exercises the registration boundary
    // without starting timers or rendering a dashboard page.
    global.__appBootstrapped = true;
    const { register } = await import("../../src/instrumentation.js?actual-lifecycle");

    await register();

    for (const signal of trackedSignals) {
      const added = process.listeners(signal).filter(
        (listener) => !baselineListeners.get(signal).has(listener)
      );
      expect(added, signal).toHaveLength(1);
    }
  });

  it("installs SIGINT, SIGTERM, and exit handlers only once", async () => {
    const { registerShutdownHandlers } = await import(
      "../../src/shared/services/initializeApp.js?shutdown-registration"
    );

    registerShutdownHandlers();
    registerShutdownHandlers();

    for (const signal of trackedSignals) {
      const added = process.listeners(signal).filter(
        (listener) => !baselineListeners.get(signal).has(listener)
      );
      expect(added, signal).toHaveLength(1);
    }
  });

  it("flushes, closes, and exits when a registered signal fires", async () => {
    const { registerShutdownHandlers } = await import(
      "../../src/shared/services/initializeApp.js?shutdown-callback"
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);

    registerShutdownHandlers();
    const cleanup = process.listeners("SIGTERM").find(
      (listener) => !baselineListeners.get("SIGTERM").has(listener)
    );

    await cleanup();

    expect(mocks.flushPendingRequestDetails).toHaveBeenCalledOnce();
    expect(mocks.closeAdapter).toHaveBeenCalledOnce();
    expect(mocks.removeAllDNSEntriesSync).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
