import { describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ getSettings: vi.fn() }));
const adapter = vi.hoisted(() => ({ transaction: vi.fn(), run: vi.fn(), get: vi.fn(), all: vi.fn() }));

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: async () => adapter }));
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => settings);

settings.getSettings.mockResolvedValue({
  enableObservability: true,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 1000,
  observabilityFlushIntervalMs: 60000,
  observabilityMaxJsonSize: 1024,
});

const { saveRequestDetail } = await import("../../src/lib/db/repos/requestDetailsRepo.js");

function bigMessages(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i} `.repeat(20),
  }));
}

describe("request detail truncation memo (P8)", () => {
  it("reuses the first serialization when saves share request/providerRequest references", async () => {
    const request = { messages: bigMessages(50), model: "test-model", stream: true };
    const providerRequest = { model: "test-model", messages: bigMessages(50) };
    const base = {
      provider: "test-provider",
      model: "test-model",
      timestamp: new Date().toISOString(),
      request,
      providerRequest,
    };

    const stringifySpy = vi.spyOn(JSON, "stringify");
    try {
      stringifySpy.mockClear();
      await saveRequestDetail({
        ...base,
        id: "memo-first",
        providerResponse: { marker: "first" },
        response: { content: "first" },
      });
      const afterFirst = stringifySpy.mock.calls.length;
      // request + providerRequest + providerResponse + response
      expect(afterFirst).toBe(4);

      await saveRequestDetail({
        ...base,
        id: "memo-second",
        providerResponse: { marker: "second" },
        response: { content: "second" },
      });
      const afterSecond = stringifySpy.mock.calls.length;
      // Only the two changed fields re-serialize; shared references memoize.
      expect(afterSecond - afterFirst).toBe(2);

      await saveRequestDetail({
        ...base,
        id: "memo-fresh",
        request: { ...request },
        providerRequest: { ...providerRequest },
        providerResponse: { marker: "third" },
        response: { content: "third" },
      });
      // Fresh identities miss the memo: all four fields serialize again.
      expect(stringifySpy.mock.calls.length - afterSecond).toBe(4);
    } finally {
      stringifySpy.mockRestore();
    }
  });
});
