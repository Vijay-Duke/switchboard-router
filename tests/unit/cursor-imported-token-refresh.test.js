import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readLocalCursorCredentials: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("../../src/lib/oauth/cursorLocalCredentials.js", () => ({
  readLocalCursorCredentials: mocks.readLocalCursorCredentials,
}));

vi.mock("../../src/lib/db/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  updateProviderConnection: mocks.updateProviderConnection,
}));

describe("imported Cursor credential refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readLocalCursorCredentials.mockResolvedValue({
      found: true,
      accessToken: "fresh-local-token",
      machineId: "fresh-machine-id",
    });
    mocks.updateProviderConnection.mockResolvedValue({ id: "cursor-1" });
  });

  it("reloads and persists the token rotated by the local Cursor IDE", async () => {
    const { refreshImportedCursorCredentials } = await import("../../src/sse/services/tokenRefresh.js");
    const refreshed = await refreshImportedCursorCredentials({
      id: "cursor-1",
      provider: "cursor",
      accessToken: "expired-token",
      expiresAt: "2020-01-01T00:00:00.000Z",
      providerSpecificData: { authMethod: "imported", machineId: "old-machine-id", extra: true },
    }, { force: true });

    expect(refreshed).toMatchObject({
      accessToken: "fresh-local-token",
      providerSpecificData: {
        authMethod: "imported",
        machineId: "fresh-machine-id",
        extra: true,
      },
    });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "cursor-1",
      expect.objectContaining({
        accessToken: "fresh-local-token",
        providerSpecificData: expect.objectContaining({ machineId: "fresh-machine-id" }),
      }),
    );
  });
});
