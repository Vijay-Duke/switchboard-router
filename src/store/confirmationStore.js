import { create } from "zustand";

let pendingResolver = null;

export const useConfirmationStore = create((set) => ({
  request: null,
  open: (request, resolve) => {
    if (pendingResolver) pendingResolver(false);
    pendingResolver = resolve;
    set({ request });
  },
  settle: (accepted) => {
    const resolve = pendingResolver;
    pendingResolver = null;
    set({ request: null });
    resolve?.(accepted);
  },
}));

/**
 * Request confirmation through the dashboard's accessible modal.
 * A new request safely cancels an older unresolved request.
 */
export function requestConfirmation(options) {
  return new Promise((resolve) => {
    useConfirmationStore.getState().open(options, resolve);
  });
}
