// O1: GET /api/usage/request-details/[id] returns the single unredacted row.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRequestDetailById: vi.fn() }));

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
vi.mock("@/lib/db/index.js", () => ({ getRequestDetailById: mocks.getRequestDetailById }));

const { GET } = await import("../../src/app/api/usage/request-details/[id]/route.js");

const call = (id) => GET(new Request(`http://localhost/api/usage/request-details/${id}`), {
  params: Promise.resolve({ id }),
});

beforeEach(() => vi.clearAllMocks());

describe("GET /api/usage/request-details/[id]", () => {
  it("returns the full row including conversation payloads", async () => {
    const detail = {
      id: "abc",
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      response: { content: "secret answer" },
    };
    mocks.getRequestDetailById.mockResolvedValue(detail);

    const response = await call("abc");
    expect(response.status).toBe(200);
    expect((await response.json()).detail).toEqual(detail);
    expect(mocks.getRequestDetailById).toHaveBeenCalledWith("abc");
  });

  it("404s for an unknown id", async () => {
    mocks.getRequestDetailById.mockResolvedValue(null);
    const response = await call("missing");
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Request detail not found");
  });

  it("400s without an id", async () => {
    const response = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "" }) });
    expect(response.status).toBe(400);
    expect(mocks.getRequestDetailById).not.toHaveBeenCalled();
  });

  it("500s when the db layer throws", async () => {
    mocks.getRequestDetailById.mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("abc");
    expect(response.status).toBe(500);
    consoleError.mockRestore();
  });
});
