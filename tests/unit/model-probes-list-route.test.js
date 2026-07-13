import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: vi.fn(async () => ({ id: "c1", provider: "p", providerSpecificData: { baseUrl: "https://x" } })),
  getProbesForScope: vi.fn(async () => [
    { modelId: "a", kind: "llm", status: "ok", latencyMs: 5, failureClass: null, checkedAt: "t" },
    { modelId: "b", kind: "llm", status: "dead", latencyMs: null, failureClass: "not_found", checkedAt: "t" },
  ]),
}));

const { GET } = await import("../../src/app/api/providers/[id]/model-probes/route.js");

describe("model-probes list route", () => {
  it("returns probes for the connection scope", async () => {
    const res = await GET({}, { params: Promise.resolve({ id: "c1" }) });
    const data = await res.json();
    expect(data.probes).toHaveLength(2);
    expect(data.probes[1].status).toBe("dead");
  });
});
