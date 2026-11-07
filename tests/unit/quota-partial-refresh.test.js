// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, flush, h } from "./dashboard-dom-harness.js";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/dashboard/quota",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));
vi.mock("@/shared/components", () => ({ ConfirmModal: () => null, EditConnectionModal: () => null, Modal: () => null }));
import ProviderLimits from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits";

const harness = createHarness();
afterEach(() => { harness.unmount(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("quota page partial refresh", () => {
  it("keeps displayed quota visible while a background refresh is in flight", async () => {
    let usageCalls = 0;
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.startsWith("/api/providers/client")) {
        return Response.json({
          connections: [{ id: "claude-a", provider: "claude", authType: "oauth", isActive: true, name: "Claude account" }],
          providerOptions: ["claude"],
          pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
          totals: { eligibleConnections: 1, providerFilteredConnections: 1 },
        });
      }
      if (u.startsWith("/api/usage/claude-a")) {
        usageCalls += 1;
        if (usageCalls > 1) await refreshGate;
        return Response.json({ quotas: { "session (5h)": { used: 37, total: 100, resetAt: null } } });
      }
      if (u.startsWith("/api/settings")) return Response.json({});
      throw new Error(`Unexpected request: ${url}`);
    }));

    const container = await harness.mount(h(ProviderLimits));
    await flush();
    expect(container.textContent).toContain("session (5h)");

    const refreshButton = container.querySelector('button[title="Refresh all"]');
    expect(refreshButton).not.toBeNull();
    await act(async () => { refreshButton.click(); });
    await flush(2);

    // The refresh is still in flight; already-displayed values must stay on
    // screen instead of being replaced by a per-card spinner.
    expect(usageCalls).toBeGreaterThan(1);
    expect(container.textContent).toContain("session (5h)");

    await act(async () => { releaseRefresh(); });
    await flush();
    expect(container.textContent).toContain("session (5h)");
  });
});
