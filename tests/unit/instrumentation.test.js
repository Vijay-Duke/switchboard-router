import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerShutdownHandlers: vi.fn(),
  initializeApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/shared/services/initializeApp.js", () => mocks);

describe("Next instrumentation bootstrap", () => {
  beforeEach(() => {
    mocks.registerShutdownHandlers.mockClear();
    mocks.initializeApp.mockClear();
    delete global.__appBootstrapped;
    delete global.__appInstrumentationRegistration;
    delete process.env.NEXT_RUNTIME;
    delete process.env.NEXT_PHASE;
  });

  it("registers shutdown and initializes the app once without a layout render", async () => {
    const { register } = await import("../../src/instrumentation.js?lifecycle-once");

    await Promise.all([register(), register()]);
    const reloaded = await import("../../src/instrumentation.js?lifecycle-reload");
    await reloaded.register();

    expect(mocks.registerShutdownHandlers).toHaveBeenCalledOnce();
    expect(mocks.initializeApp).toHaveBeenCalledOnce();
  });

  it("does not bootstrap during build or in the edge runtime", async () => {
    const { register } = await import("../../src/instrumentation.js?lifecycle-guards");

    process.env.NEXT_PHASE = "phase-production-build";
    await register();
    process.env.NEXT_PHASE = "phase-production-server";
    process.env.NEXT_RUNTIME = "edge";
    await register();

    expect(mocks.registerShutdownHandlers).not.toHaveBeenCalled();
    expect(mocks.initializeApp).not.toHaveBeenCalled();
  });
});
