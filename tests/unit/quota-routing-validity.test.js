import { afterEach, describe, expect, it, vi } from "vitest";
const rows = vi.hoisted(() => []);
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => ({ all: () => rows }) }));
import { getProviderQuotaHeadroom } from "@/lib/db/repos/connectionsRepo.js";
const NOW = 1791507000000;
function account(id, snapshot, active = true) {
  return { id, provider: "claude", isActive: active ? 1 : 0, data: JSON.stringify({ lastQuota: snapshot }) };
}
afterEach(() => { rows.length = 0; vi.restoreAllMocks(); });
describe("quota-based routing ignores invalid observations", () => {
  it("ignores disabled, expired, unknown, and future observations", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    rows.push(
      account("disabled", { at: NOW, remainingPercentage: 100 }, false),
      account("reset-passed", { at: NOW, remainingPercentage: 95, resetAt: new Date(NOW - 1).toISOString() }),
      account("unknown", { at: NOW, remainingPercentage: null }),
      account("future", { at: NOW + 1000, remainingPercentage: 90 }),
      account("real", { at: NOW, remainingPercentage: 3, resetAt: new Date(NOW + 10000).toISOString() }),
    );
    expect(await getProviderQuotaHeadroom()).toEqual({ claude: 3 });
  });
  it("preserves a genuine exhausted zero instead of treating it as missing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    rows.push(account("exhausted", { at: NOW, remainingPercentage: 0 }));
    expect(await getProviderQuotaHeadroom()).toEqual({ claude: 0 });
  });
});
