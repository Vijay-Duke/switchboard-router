import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestDetails: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

// The route imports via the public barrel; mock it the way sibling route
// tests do (only the exports the route actually consumes).
vi.mock("@/lib/db/index.js", () => ({
  getRequestDetails: mocks.getRequestDetails,
}));

const { GET } = await import("../../src/app/api/usage/request-details/route.js");

function detailRow(overrides = {}) {
  return {
    id: "abc",
    provider: "opencode",
    model: "deepseek-v4-flash-free",
    timestamp: "2026-08-05T00:00:00Z",
    status: "success",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    latency: { total: 123 },
    request: { messages: [{ role: "user", content: "secret prompt" }] },
    providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
    providerResponse: { choices: [{ message: { content: "secret answer" } }] },
    response: { content: "secret answer" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/usage/request-details redaction", () => {
  it("replaces conversation payloads but preserves metadata", async () => {
    const row = detailRow();
    const source = structuredClone(row);
    mocks.getRequestDetails.mockResolvedValue({
      details: [row],
      pagination: { page: 1, pageSize: 20, totalItems: 1 },
    });

    const response = await GET(new Request("http://localhost/api/usage/request-details"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getRequestDetails).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 20 })
    );
    // Payloads replaced wholesale — no message content survives.
    expect(body.details[0].request).toEqual({ redacted: true });
    expect(body.details[0].providerRequest).toEqual({ redacted: true });
    expect(body.details[0].providerResponse).toEqual({ redacted: true });
    expect(body.details[0].response).toEqual({ redacted: true });
    expect(JSON.stringify(body)).not.toContain("secret prompt");
    expect(JSON.stringify(body)).not.toContain("secret answer");
    // Metadata kept.
    expect(body.details[0].id).toBe("abc");
    expect(body.details[0].provider).toBe("opencode");
    expect(body.details[0].model).toBe("deepseek-v4-flash-free");
    expect(body.details[0].tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(body.details[0].latency).toEqual({ total: 123 });
    expect(body.details[0].status).toBe("success");
    // Envelope metadata (pagination) preserved.
    expect(body.pagination).toEqual({ page: 1, pageSize: 20, totalItems: 1 });
    // Redaction works on a copy — the stored row is not mutated.
    expect(row).toEqual(source);
  });

  it("leaves rows without payload keys untouched", async () => {
    mocks.getRequestDetails.mockResolvedValue({
      details: [{ id: "x", status: "error", latency: { total: 100 } }],
      pagination: { page: 1, pageSize: 20, totalItems: 1 },
    });

    const response = await GET(new Request("http://localhost/api/usage/request-details"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.details[0]).toEqual({ id: "x", status: "error", latency: { total: 100 } });
  });

  it("handles empty and missing details collections", async () => {
    mocks.getRequestDetails.mockResolvedValueOnce({ details: [], pagination: { totalItems: 0 } });
    let response = await GET(new Request("http://localhost/api/usage/request-details"));
    let body = await response.json();
    expect(response.status).toBe(200);
    expect(body.details).toEqual([]);
    expect(body.pagination).toEqual({ totalItems: 0 });

    mocks.getRequestDetails.mockResolvedValueOnce({});
    response = await GET(new Request("http://localhost/api/usage/request-details"));
    body = await response.json();
    expect(response.status).toBe(200);
    expect(body.details).toEqual([]);
  });

  it.each([
    ["", 1],
    ["abc", 1],
    ["3", 3],
  ])("parses page=%s NaN-safely as %i", async (raw, expectedPage) => {
    mocks.getRequestDetails.mockResolvedValue({ details: [] });
    const url = new URL("http://localhost/api/usage/request-details");
    if (raw) url.searchParams.set("page", raw);

    await GET(new Request(url));
    expect(mocks.getRequestDetails).toHaveBeenCalledWith(
      expect.objectContaining({ page: expectedPage })
    );
  });

  it.each([
    ["", 20],
    ["not-a-number", 20],
    ["50", 50],
  ])("parses pageSize=%s NaN-safely as %i", async (raw, expectedPageSize) => {
    mocks.getRequestDetails.mockResolvedValue({ details: [] });
    const url = new URL("http://localhost/api/usage/request-details");
    if (raw) url.searchParams.set("pageSize", raw);

    await GET(new Request(url));
    expect(mocks.getRequestDetails).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: expectedPageSize })
    );
  });

  it("rejects out-of-range numeric params instead of coercing them", async () => {
    mocks.getRequestDetails.mockResolvedValue({ details: [] });

    let response = await GET(new Request("http://localhost/api/usage/request-details?page=0"));
    expect(response.status).toBe(400);

    response = await GET(new Request("http://localhost/api/usage/request-details?page=-5&pageSize=101"));
    expect(response.status).toBe(400);
    expect(mocks.getRequestDetails).not.toHaveBeenCalled();
  });

  it("returns 500 when the db layer throws", async () => {
    mocks.getRequestDetails.mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(new Request("http://localhost/api/usage/request-details"));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Failed to fetch request details");
    consoleError.mockRestore();
  });
});
