// T90: matchKnownEndpoint must anchor local-hostname matching so spoofed hosts
// (localhost.evil.com) can never masquerade as local, while bracketed IPv6
// ([::1]) and subpaths of tunnel/tailscale URLs still match.

import { describe, expect, it } from "vitest";
import { matchKnownEndpoint } from "@/app/(dashboard)/dashboard/cli-tools/components/cliEndpointMatch";

const OPTS = {
  tunnelPublicUrl: "https://abc123.loca.lt",
  tailscaleUrl: "https://box.tail1234.ts.net",
};

describe("matchKnownEndpoint (T90)", () => {
  it("accepts every local hostname form", () => {
    for (const url of [
      "http://localhost:20128/v1",
      "http://127.0.0.1:20128/v1",
      "http://0.0.0.0:20128/v1",
      "http://[::1]:20128/v1",
      "http://localhost:20128/v1/",
    ]) {
      expect(matchKnownEndpoint(url, OPTS), url).toBe(true);
    }
  });

  it("rejects spoofed subdomain hosts", () => {
    for (const url of [
      "https://localhost.evil.com/v1",
      "https://127.0.0.1.evil.com/v1",
      "https://evil-localhost.com/v1",
      "https://abc123.loca.lt.evil.com/v1",
      "https://evil.com/?x=http://localhost",
    ]) {
      expect(matchKnownEndpoint(url, OPTS), url).toBe(false);
    }
  });

  it("matches tunnel and tailscale URLs including subpaths", () => {
    for (const url of [
      "https://abc123.loca.lt/v1",
      "https://abc123.loca.lt/v1/",
      "https://box.tail1234.ts.net/v1",
      "https://box.tail1234.ts.net/some/sub/path",
    ]) {
      expect(matchKnownEndpoint(url, OPTS), url).toBe(true);
    }
  });

  it("still matches cloud URLs and rejects everything else", () => {
    expect(matchKnownEndpoint("https://gw.switchboard.app/v1", { cloudUrl: "https://gw.switchboard.app" })).toBe(true);
    expect(matchKnownEndpoint("https://api.openai.com/v1", OPTS)).toBe(false);
    expect(matchKnownEndpoint("", OPTS)).toBe(false);
  });
});
