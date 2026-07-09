// @ts-check
import { loadProvidersPage } from "@/lib/dashboard/loaders";
import ProvidersPageClient from "./ProvidersPageClient";

/**
 * Providers list — server read, client interactions.
 */
export default async function ProvidersPage() {
  const initialData = await loadProvidersPage();
  return <ProvidersPageClient initialData={initialData} />;
}
