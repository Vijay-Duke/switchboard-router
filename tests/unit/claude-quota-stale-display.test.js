// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, h } from "./dashboard-dom-harness.js";
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));
vi.mock("@/shared/components", () => ({ ConfirmModal: () => null, EditConnectionModal: () => null, Modal: () => null }));
import ProviderLimits from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits";

const harness = createHarness();
afterEach(() => { harness.unmount(); vi.unstubAllGlobals(); localStorage.clear(); });
describe("Claude quota stale display", () => {
  it("renders saved quota percentages and a stale notice together", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).startsWith("/api/providers/client")) return Response.json({ connections: [{ id: "claude-a", provider: "claude", authType: "oauth", isActive: true, name: "Claude account" }], providerOptions: ["claude"], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
      if (String(url).startsWith("/api/usage/claude-a")) return Response.json({ stale: true, status: 429, message: "Usage is rate-limited until 04:47 GMT.", quotas: { "session (5h)": { used: 37, total: 100, resetAt: null } } });
      if (String(url).startsWith("/api/settings")) return Response.json({});
      throw new Error(`Unexpected request: ${url}`);
    }));
    const container = await harness.mount(h(ProviderLimits));
    expect(container.textContent).toContain("Showing last known usage.");
    expect(container.textContent).toContain("session (5h)");
    expect(container.textContent).toContain("63%");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("rate-limited");
  });
});
