// Quota entry points also run before the chat handlers initialize the full app.
import { setOpenSseDeps } from "open-sse/runtimeDeps.js";
import { loadProviderQuotaState, saveProviderQuotaState } from "@/lib/db/repos/providerQuotaStateRepo.js";

setOpenSseDeps({ loadProviderQuotaState, saveProviderQuotaState });
