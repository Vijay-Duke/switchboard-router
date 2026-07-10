import { afterEach, describe, expect, it } from "vitest";

import {
  requestConfirmation,
  useConfirmationStore,
} from "../../src/store/confirmationStore.js";

afterEach(() => {
  useConfirmationStore.getState().settle(false);
});

describe("confirmation store", () => {
  it("resolves the active request with the modal decision", async () => {
    const decision = requestConfirmation({ message: "Delete provider?" });

    expect(useConfirmationStore.getState().request).toEqual({
      message: "Delete provider?",
    });
    useConfirmationStore.getState().settle(true);

    await expect(decision).resolves.toBe(true);
    expect(useConfirmationStore.getState().request).toBeNull();
  });

  it("cancels an older request when a new confirmation replaces it", async () => {
    const first = requestConfirmation({ message: "First" });
    const second = requestConfirmation({ message: "Second" });

    await expect(first).resolves.toBe(false);
    expect(useConfirmationStore.getState().request).toEqual({ message: "Second" });

    useConfirmationStore.getState().settle(false);
    await expect(second).resolves.toBe(false);
  });
});
