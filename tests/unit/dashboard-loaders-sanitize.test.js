import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/index.js", () => ({
  getSettings: vi.fn(async () => ({
    requireApiKey: true,
    outboundProxyUrl: "http://u:p@x",
    outboundNoProxy: "localhost,127.0.0.1",
    ssrfAllowHosts: ["169.254.169.254"],
    mitmSudoEncrypted: "iv:tag:ct",
    headroomUrl: "http://headroom",
    comboStrategies: { auto: {} },
  })),
  getApiKeys: vi.fn(async () => []),
  getProviderConnections: vi.fn(async () => []),
  getProviderNodes: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
}));

vi.mock("@/shared/utils/machine.js", () => ({
  getMachineId: vi.fn(async () => "testmachine123456"),
}));

const { loadProfilePage, loadEndpointPage } = await import("../../src/lib/dashboard/loaders.js");

describe("dashboard loaders sanitize settings (C1)", () => {
  it("strips sudo ciphertext and SSRF allowlist from profile settings, keeps the proxy form fields", async () => {
    const { settings } = await loadProfilePage();
    expect(settings).not.toHaveProperty("ssrfAllowHosts");
    expect(settings).not.toHaveProperty("mitmSudoEncrypted");
    expect(settings).not.toHaveProperty("password");
    // ProfilePageClient hydrates its proxy form from initialData (no refetch);
    // the /dashboard guard gates this payload exactly like /api/settings.
    expect(settings.outboundProxyUrl).toBe("http://u:p@x");
    expect(settings.outboundNoProxy).toBe("localhost,127.0.0.1");
  });

  it("strips the same keys from the endpoint page settings", async () => {
    const { settings } = await loadEndpointPage();
    expect(settings).not.toHaveProperty("ssrfAllowHosts");
    expect(settings).not.toHaveProperty("mitmSudoEncrypted");
    expect(settings).not.toHaveProperty("password");
  });
});
