import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: vi.fn(async () => ({ id: "c1", provider: "openai-compatible", providerSpecificData: { baseUrl: "https://x" } })),
  upsertProbeResult: vi.fn(async () => {}),
  getProbesForScope: vi.fn(async () => []),
}));

const startVerify = vi.fn(async () => ({ status: "running", total: 2, done: 0 }));
const getVerifyStatus = vi.fn(() => ({ status: "running", done: 1, total: 2 }));
const cancelVerify = vi.fn(() => true);
vi.mock("@/lib/model-probe/verifyJob.js", () => ({ startVerify, getVerifyStatus, cancelVerify }));

const { POST: startPOST } = await import("../../src/app/api/providers/[id]/model-probes/verify/start/route.js");
const { GET: statusGET } = await import("../../src/app/api/providers/[id]/model-probes/verify/status/route.js");
const { POST: cancelPOST } = await import("../../src/app/api/providers/[id]/model-probes/verify/cancel/route.js");

const params = Promise.resolve({ id: "c1" });
const req = (body) => ({ json: async () => body });

describe("verify routes", () => {
  beforeEach(() => { startVerify.mockClear(); getVerifyStatus.mockClear(); cancelVerify.mockClear(); });

  it("start kicks the job and returns a snapshot", async () => {
    const res = await startPOST(req({ models: [{ id: "a" }, { id: "b" }], providerAlias: "openai-compatible" }), { params });
    const data = await res.json();
    expect(startVerify).toHaveBeenCalledOnce();
    expect(data.status).toBe("running");
  });

  it("status returns the snapshot", async () => {
    const res = await statusGET({}, { params });
    const data = await res.json();
    expect(data.done).toBe(1);
  });

  it("cancel calls cancelVerify", async () => {
    const res = await cancelPOST(req({}), { params });
    const data = await res.json();
    expect(cancelVerify).toHaveBeenCalledWith("c1");
    expect(data.cancelled).toBe(true);
  });
});
