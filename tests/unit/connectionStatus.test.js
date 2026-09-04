import { describe, expect, it } from "vitest";
import {
  getStatusVariant,
  isErrorStatus,
} from "../../src/shared/utils/connectionStatus.js";

describe("connection status taxonomy (D13)", () => {
  it("maps healthy statuses to success", () => {
    expect(getStatusVariant(true, "active")).toBe("success");
    expect(getStatusVariant(true, "success")).toBe("success");
  });

  it("maps failure statuses to error, including reauth_required and invalid", () => {
    for (const status of ["error", "expired", "unavailable", "reauth_required", "invalid"]) {
      expect(getStatusVariant(true, status)).toBe("error");
      expect(isErrorStatus(status)).toBe(true);
    }
  });

  it("maps unknown statuses to default", () => {
    expect(getStatusVariant(true, "mystery")).toBe("default");
    expect(getStatusVariant(true, undefined)).toBe("default");
    expect(isErrorStatus("mystery")).toBe(false);
    expect(isErrorStatus("active")).toBe(false);
    expect(isErrorStatus("success")).toBe(false);
  });

  it("forces default for disabled connections regardless of status", () => {
    expect(getStatusVariant(false, "active")).toBe("default");
    expect(getStatusVariant(false, "reauth_required")).toBe("default");
  });

  it("counts a reauth_required fixture row as an error (stats parity)", () => {
    const rows = [
      { testStatus: "active" },
      { testStatus: "reauth_required" },
      { testStatus: "invalid" },
      { testStatus: "success" },
    ];
    expect(rows.filter((r) => isErrorStatus(r.testStatus))).toHaveLength(2);
  });
});
