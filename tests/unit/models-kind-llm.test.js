/**
 * QA-025 — GET /v1/models/llm must return the LLM-filtered OpenAI-compatible
 * model list (same filter as GET /v1/models) instead of 404.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ buildModelsList: vi.fn() }));

vi.mock("@/app/api/v1/models/route.js", () => ({ buildModelsList: mocks.buildModelsList }));

const { GET } = await import("../../src/app/api/v1/models/[kind]/route.js");

const LLM_LIST = [
  { id: "qa-openai/qa-chat", object: "model", owned_by: "qa-openai" },
  { id: "qa-responses/qa-response", object: "model", owned_by: "qa-responses" },
  { id: "qa-anthropic/qa-message", object: "model", owned_by: "qa-anthropic" },
];

function getByKind(kind) {
  return GET(new Request(`http://localhost/v1/models/${kind}`, { method: "GET" }), {
    params: Promise.resolve({ kind }),
  });
}

describe("GET /v1/models/[kind] llm discovery (QA-025)", () => {
  beforeEach(() => {
    mocks.buildModelsList.mockReset().mockResolvedValue(LLM_LIST);
  });

  it("accepts the llm kind and returns the filtered OpenAI-compatible list", async () => {
    const res = await getByKind("llm");
    expect(res.status).toBe(200);
    expect(mocks.buildModelsList.mock.calls[0][0]).toEqual(["llm"]);
    const body = JSON.parse(await res.text());
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual([
      "qa-openai/qa-chat",
      "qa-responses/qa-response",
      "qa-anthropic/qa-message",
    ]);
  });

  it("still serves the other capability kinds", async () => {
    const res = await getByKind("image");
    expect(res.status).toBe(200);
    expect(mocks.buildModelsList).toHaveBeenCalledWith(["image"], expect.anything());
  });

  it("unknown kind remains a 404 that lists llm as supported", async () => {
    const res = await getByKind("bogus");

    expect(res.status).toBe(404);
    const body = JSON.parse(await res.text());
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("llm");
  });
});
