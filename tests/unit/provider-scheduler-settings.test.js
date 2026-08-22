import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  getSettings: vi.fn(),
}));
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

it("accepts bounded nested scheduler settings while preserving sibling strategy fields", async () => {
  const body = {
    providerStrategies: {
      anthropic: {
        fallbackStrategy: "round-robin",
        stickyRoundRobinLimit: 4,
        proxyPoolId: "legacy-field",
        accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 1_800 },
      },
    },
  };
  const response = await PATCH(request(body));
  expect(response.status).toBe(200);
  expect(mocks.updateSettings).toHaveBeenCalledWith(body);
});

it.each([
  [null, "providerStrategies"],
  [[], "providerStrategies"],
  [{ p: { accountScheduler: null } }, "accountScheduler"],
  [{ p: { accountScheduler: { enabled: "yes", sessionAffinityTtlSeconds: 1_800 } } }, "enabled"],
  [{ p: { accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 59 } } }, "sessionAffinityTtlSeconds"],
  [{ p: { accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 86_401 } } }, "sessionAffinityTtlSeconds"],
  [{ p: { accountScheduler: { enabled: true, sessionAffinityTtlSeconds: 60.5 } } }, "sessionAffinityTtlSeconds"],
])("rejects invalid scheduler settings %j", async (providerStrategies, field) => {
  const response = await PATCH(request({ providerStrategies }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain(field);
  expect(mocks.updateSettings).not.toHaveBeenCalled();
});
