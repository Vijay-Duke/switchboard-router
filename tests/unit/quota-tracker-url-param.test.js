// @vitest-environment happy-dom
// Upstream #4217: /dashboard/quota?provider=<id> preselects that provider and
// changing the filter keeps the URL in sync (bookmarkable deep links).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, flush, h } from "./dashboard-dom-harness.js";

const nav = vi.hoisted(() => ({ replace: vi.fn(), params: new URLSearchParams("provider=claude") }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => "/dashboard/quota",
  useSearchParams: () => nav.params,
}));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));
vi.mock("@/shared/components", () => ({ ConfirmModal: () => null, EditConnectionModal: () => null, Modal: () => null }));
import ProviderLimits from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits";

const harness = createHarness();
afterEach(() => { harness.unmount(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("ProviderLimits ?provider= deep link", () => {
  it("requests the provider from the URL on first load", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.startsWith("/api/providers/client")) {
        return Response.json({
          connections: [], providerOptions: ["claude", "codex"],
          pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
          totals: { eligibleConnections: 0, providerFilteredConnections: 0 },
        });
      }
      if (u.startsWith("/api/settings")) return Response.json({});
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    await harness.mount(h(ProviderLimits));
    await flush();

    const listCall = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.startsWith("/api/providers/client"));
    expect(listCall).toContain("provider=claude");
  });
});
