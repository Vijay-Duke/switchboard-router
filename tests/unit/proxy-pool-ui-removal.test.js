import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("removed proxy-pool feature", () => {
  it("does not expose dead proxy-pool controls in connection forms", () => {
    const providerModal = source("src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js");
    const mediaConnections = source("src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js");

    for (const uiSource of [providerModal, mediaConnections]) {
      expect(uiSource).not.toContain('label="Proxy Pool"');
      expect(uiSource).not.toContain("proxyPoolId");
      expect(uiSource).not.toContain("/api/proxy-pools");
    }
    expect(providerModal).not.toContain("Create one in Proxy Pools page first");
  });

  it("keeps the API removal contract explicit", () => {
    const createRoute = source("src/app/api/providers/route.js");
    const updateRoute = source("src/app/api/providers/[id]/route.js");

    expect(createRoute).toContain("Proxy pools removed");
    expect(createRoute).toContain("proxyPoolId: null");
    expect(updateRoute).toContain("Proxy pools removed");
    expect(updateRoute).toContain("proxyPoolId: null");
  });
});
