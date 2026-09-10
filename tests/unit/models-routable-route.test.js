/**
 * GET /api/models/routable — the auth-free dashboard mirror of the gateway's
 * LLM model list. Dashboard pickers cannot call /api/v1/models (they hold no
 * client API key), so this route must keep the { data: [...] } shape the
 * pickers parse and stay LLM-only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ buildModelsList: vi.fn() }));

vi.mock("@/app/api/v1/models/route.js", () => ({ buildModelsList: mocks.buildModelsList }));

const { GET } = await import("../../src/app/api/models/routable/route.js");

describe("GET /api/models/routable", () => {
  beforeEach(() => {
    mocks.buildModelsList.mockReset().mockResolvedValue([
      { id: "qa-openai/qa-chat", object: "model", created: 0, owned_by: "qa-openai" },
    ]);
  });

  it("returns the LLM-only list under data with no API key", async () => {
    const res = await GET(new Request("http://localhost/api/models/routable"));

    expect(res.status).toBe(200);
    expect(mocks.buildModelsList.mock.calls[0][0]).toEqual(["llm"]);
    const body = await res.json();
    expect(body.data.map((m) => m.id)).toEqual(["qa-openai/qa-chat"]);
  });

  it("returns a 500 instead of throwing when the list build fails", async () => {
    mocks.buildModelsList.mockRejectedValue(new Error("catalog exploded"));

    const res = await GET(new Request("http://localhost/api/models/routable"));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBeTruthy();
  });
});
