import { describe, expect, it, vi } from "vitest";
import { get, post } from "@/shared/utils/api";

function stubFetch(response) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response)));
}

describe("shared api handleResponse (D11)", () => {
  it("resolves null on 204 success with an empty body", async () => {
    stubFetch({
      ok: true,
      status: 204,
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
    });
    await expect(get("/api/things")).resolves.toBeNull();
  });

  it("throws Error with status (not SyntaxError) on 500 with an HTML body", async () => {
    stubFetch({
      ok: false,
      status: 500,
      json: () => Promise.reject(new SyntaxError("Unexpected token '<'")),
    });
    const err = await post("/api/things", {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err.status).toBe(500);
  });

  it("still surfaces the server error message when the body parses", async () => {
    stubFetch({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "Name taken" }),
    });
    const err = await post("/api/things", {}).catch((e) => e);
    expect(err.message).toBe("Name taken");
    expect(err.status).toBe(400);
  });
});
