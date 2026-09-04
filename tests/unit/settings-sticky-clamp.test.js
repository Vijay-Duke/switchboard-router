// O20 (server side): sticky limits are clamped in the settings PATCH route.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ updateSettings: vi.fn(), getSettings: vi.fn() }));
vi.mock("@/lib/db/index.js", () => ({ ...mocks }));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
vi.mock("@/shared/services/quotaAutoPing", () => ({ runQuotaAutoPingTick: vi.fn() }));

const { PATCH } = await import("../../src/app/api/settings/route.js");
const request = (body) => new Request("http://localhost/api/settings", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateSettings.mockImplementation(async (body) => body);
});

describe("settings sticky-limit clamp (O20)", () => {
  it.each([
    [{ stickyRoundRobinLimit: 1000000 }, { stickyRoundRobinLimit: 32 }],
    [{ stickyRoundRobinLimit: 0 }, { stickyRoundRobinLimit: 1 }],
    [{ stickyRoundRobinLimit: "7" }, { stickyRoundRobinLimit: 7 }],
    [{ comboStickyRoundRobinLimit: 500 }, { comboStickyRoundRobinLimit: 100 }],
    [{ comboStickyRoundRobinLimit: -3 }, { comboStickyRoundRobinLimit: 1 }],
  ])("clamps %j to %j", async (body, stored) => {
    const response = await PATCH(request(body));
    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith(stored);
  });

  it("rejects a non-numeric sticky limit", async () => {
    const response = await PATCH(request({ stickyRoundRobinLimit: "lots" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("stickyRoundRobinLimit");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
