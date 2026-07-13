import { describe, expect, it } from "vitest";

import { getProviderModelToolbarActions } from "../../src/app/(dashboard)/dashboard/providers/[id]/providerModelActions.js";

describe("provider model toolbar actions", () => {
  it("offers batch verification for compatible providers with an active connection", () => {
    expect(
      getProviderModelToolbarActions({
        isCompatible: true,
        hasActiveConnection: true,
      }),
    ).toEqual({
      showToolbar: true,
      showImport: false,
      showVerify: true,
      showBulkControls: false,
    });
  });

  it("keeps verification unavailable until a connection is active", () => {
    expect(getProviderModelToolbarActions({
        isCompatible: true,
        hasActiveConnection: false,
      })).toEqual({
        showToolbar: false,
        showImport: false,
        showVerify: false,
        showBulkControls: false,
      });
  });

  it("preserves all toolbar actions for catalog providers", () => {
    expect(
      getProviderModelToolbarActions({
        isCompatible: false,
        hasActiveConnection: true,
      }),
    ).toEqual({
      showToolbar: true,
      showImport: true,
      showVerify: true,
      showBulkControls: true,
    });
  });
});
