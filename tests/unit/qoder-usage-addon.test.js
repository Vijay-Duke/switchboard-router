import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch, proxyOptionsFromCredentials: () => null }));

import { getQoderUsage } from "../../open-sse/services/usage/misc.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => proxyAwareFetch.mockReset());

describe("Qoder usage add-on credits", () => {
  it("surfaces an add-on bucket and flags the never-expires sentinel", async () => {
    proxyAwareFetch.mockResolvedValueOnce(json({
      userQuota: { total: 0, used: 0, remaining: 0 },
      addOnQuota: { total: 2200, used: 200, remaining: 2000, detailUrl: "https://qoder.com/account/usage" },
      expiresAt: 253402214400000,
    }));

    const usage = await getQoderUsage("tok");

    expect(usage.quotas.user).toMatchObject({ resetAt: null, neverExpires: true });
    expect(usage.quotas.addOn).toMatchObject({
      total: 2200, used: 200, remaining: 2000, resetAt: null, neverExpires: false,
      detailUrl: "https://qoder.com/account/usage",
    });

    const rows = parseQuotaData("qoder", usage);
    expect(rows.map((r) => r.name)).toContain("Add-on credits");
  });

  it("omits the add-on bucket when the account holds no grant", async () => {
    proxyAwareFetch.mockResolvedValueOnce(json({
      userQuota: { total: 100, used: 10, remaining: 90 },
      expiresAt: 1893456000000,
    }));

    const usage = await getQoderUsage("tok");

    expect(usage.quotas.addOn).toBeUndefined();
    expect(usage.quotas.user.neverExpires).toBe(false);
    expect(usage.quotas.user.resetAt).toBe(new Date(1893456000000).toISOString());
  });
});
