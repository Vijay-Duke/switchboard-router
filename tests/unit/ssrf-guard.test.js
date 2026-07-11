import { describe, expect, it } from "vitest";

import { assertPublicUrl } from "../../open-sse/utils/ssrfGuard.js";

describe("SSRF guard IPv4-mapped IPv6 handling", () => {
  it("rejects hexadecimal IPv4-mapped loopback addresses", () => {
    expect(() => assertPublicUrl("http://[::ffff:7f00:1]/metadata")).toThrow(/private IP/);
  });
});
