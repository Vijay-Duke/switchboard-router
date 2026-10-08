import { getAdapter } from "../driver.js";
import { createProviderQuotaStateStore } from "./providerQuotaStateStore.js";

export const { loadProviderQuotaState, saveProviderQuotaState } = createProviderQuotaStateStore(getAdapter);
