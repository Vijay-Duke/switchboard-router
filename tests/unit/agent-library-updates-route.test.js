// @ts-check
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkSkillUpdates: vi.fn(),
  previewSkillUpdate: vi.fn(),
  updateSkillFromSource: vi.fn(),
}));

vi.mock("@/lib/agent-library/index.js", () => ({
  loadSettings: vi.fn(async () => ({})),
  resolveLibraryRoot: vi.fn(() => "/tmp/lib-root"),
  checkSkillUpdates: mocks.checkSkillUpdates,
  previewSkillUpdate: mocks.previewSkillUpdate,
  updateSkillFromSource: mocks.updateSkillFromSource,
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

const { GET, POST } = await import("@/app/api/agent-library/updates/route.js");

/** @param {any} body */
function req(body) {
  return /** @type {any} */ ({ json: async () => body });
}

describe("agent-library updates route", () => {
  it("GET returns check results", async () => {
    mocks.checkSkillUpdates.mockResolvedValue({
      results: [{ id: "a", status: "update" }],
      skipped: 0,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ id: "a", status: "update" }],
      skipped: 0,
    });
  });

  it("POST update coerces string 'true' to confirmed:false (strict gate) and maps ok:false to 400", async () => {
    mocks.updateSkillFromSource.mockResolvedValue({
      ok: false,
      error: "confirmation_required",
    });
    const res = await POST(
      req({ action: "update", skillId: "a", confirmed: "true", expectedHash: "x" })
    );
    expect(res.status).toBe(400);
    expect(mocks.updateSkillFromSource).toHaveBeenCalledWith(
      "/tmp/lib-root",
      "a",
      expect.objectContaining({ confirmed: false })
    );
  });

  it("POST update passes confirmed:true through and maps ok:true to 200", async () => {
    mocks.updateSkillFromSource.mockResolvedValue({ ok: true, id: "a" });
    const res = await POST(
      req({ action: "update", skillId: "a", confirmed: true, expectedHash: "x" })
    );
    expect(res.status).toBe(200);
    expect(mocks.updateSkillFromSource).toHaveBeenLastCalledWith(
      "/tmp/lib-root",
      "a",
      expect.objectContaining({ confirmed: true, expectedHash: "x" })
    );
  });

  it("POST preview failure → 400", async () => {
    mocks.previewSkillUpdate.mockResolvedValue({ ok: false, error: "not_url_source" });
    const res = await POST(req({ action: "preview", skillId: "manual" }));
    expect(res.status).toBe(400);
  });

  it("POST without skillId / unknown action → 400", async () => {
    expect((await POST(req({ action: "preview" }))).status).toBe(400);
    expect((await POST(req({ action: "nope", skillId: "a" }))).status).toBe(400);
  });
});
