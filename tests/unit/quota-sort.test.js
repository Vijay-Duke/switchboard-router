// O10: codex remaining-sort must fall back to name order (no NaN) when
// neither card has quota data.

import { describe, expect, it } from "vitest";
import {
  sortVisibleConnections,
  getConnectionQuotaRemaining,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const conns = [
  { id: "b", provider: "codex", name: "Bravo" },
  { id: "a", provider: "codex", name: "Alpha" },
  { id: "c", provider: "codex", name: "Charlie" },
];

describe("sortVisibleConnections (O10)", () => {
  it("keeps quota-less codex cards in stable name order for remaining-asc", () => {
    expect(getConnectionQuotaRemaining(conns[0], {})).toBe(Number.POSITIVE_INFINITY);
    const sorted = sortVisibleConnections(conns, {}, false, "codex", "remaining-asc");
    expect(sorted.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("orders cards with quota ahead of quota-less ones, then by name", () => {
    const quotaData = { c: { quotas: [{ remaining: 40 }] } };
    const asc = sortVisibleConnections(conns, quotaData, false, "codex", "remaining-asc");
    expect(asc.map((c) => c.id)).toEqual(["c", "a", "b"]);
    const desc = sortVisibleConnections(conns, quotaData, false, "codex", "remaining-desc");
    expect(desc.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("expiring-first keeps reset-less accounts in provider/name order", () => {
    const sorted = sortVisibleConnections(conns, {}, true, "all", "default");
    expect(sorted.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});
