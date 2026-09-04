import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));
vi.mock("../../src/sse/handlers/chat.js", () => ({ handleChat: vi.fn() }));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn() }));
vi.mock("open-sse/utils/error.js", () => ({
  errorResponse: (status, message) => new Response(JSON.stringify({ error: { message } }), { status }),
}));
vi.mock("open-sse/config/runtimeConfig.js", () => ({ HTTP_STATUS: { BAD_REQUEST: 400 } }));

const responsesRoute = await import("../../src/app/api/v1/responses/route.js");
const compactRoute = await import("../../src/app/api/v1/responses/compact/route.js");
const { jsonError, safeErrorMessage } = await import("../../src/lib/jsonError.js");

describe("responses OPTIONS (A26)", () => {
  it.each([
    ["responses", responsesRoute],
    ["compact", compactRoute],
  ])("%s advertises only POST, OPTIONS", async (_name, route) => {
    const res = await route.OPTIONS();
    const methods = res.headers.get("access-control-allow-methods");
    expect(methods).toContain("POST");
    expect(methods).toContain("OPTIONS");
    expect(methods).not.toMatch(/(^|,\s*)GET(,|$)/);
  });
});

describe("jsonError 5xx generic (A27)", () => {
  it("returns a static message for 5xx without echoing driver text", async () => {
    const res = jsonError(500, new Error("sqlite: boom"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("boom");
    expect(JSON.parse(text)).toEqual({ error: "Unexpected error" });
  });

  it("keeps caller-chosen string messages on 5xx (operator-facing failures)", async () => {
    const res = jsonError(500, "Failed to start MITM server: incorrect sudo password");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to start MITM server: incorrect sudo password" });
  });

  it("keeps author-chosen messages for 4xx", async () => {
    const res = jsonError(400, "Invalid period");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid period" });
  });

  it("safeErrorMessage still extracts text for explicit callers", () => {
    expect(safeErrorMessage(new Error("x"))).toBe("x");
    expect(safeErrorMessage("y")).toBe("y");
    expect(safeErrorMessage(null)).toBe("Unexpected error");
  });
});
