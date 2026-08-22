import { expect, it, vi } from "vitest";

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));

const HANDLER_SLOT = "__switchboardRequestDetailsBeforeExitHandler";

it("keeps one beforeExit handler across module reloads", async () => {
  const baselineListeners = process.listeners("beforeExit");
  const hadHandlerSlot = Object.hasOwn(globalThis, HANDLER_SLOT);
  const baselineHandler = globalThis[HANDLER_SLOT];

  try {
    const freshImports = [
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=0"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=1"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=2"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=3"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=4"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=5"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=6"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=7"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=8"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=9"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=10"),
      () => import("../../src/lib/db/repos/requestDetailsRepo.js?listener-owner=11"),
    ];
    let currentModule;
    for (const freshImport of freshImports) currentModule = await freshImport();

    const listenersAfterReloads = process.listeners("beforeExit");
    expect(listenersAfterReloads.length).toBeLessThanOrEqual(baselineListeners.length + 1);
    expect(globalThis[HANDLER_SLOT]).toBe(currentModule.flushPendingRequestDetails);
    expect(listenersAfterReloads.filter((listener) => listener === currentModule.flushPendingRequestDetails)).toHaveLength(1);
  } finally {
    process.removeAllListeners("beforeExit");
    for (const listener of baselineListeners) process.on("beforeExit", listener);

    if (hadHandlerSlot) globalThis[HANDLER_SLOT] = baselineHandler;
    else delete globalThis[HANDLER_SLOT];
  }
});
