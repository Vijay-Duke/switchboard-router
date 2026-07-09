// @ts-check
import { loadEndpointPage } from "@/lib/dashboard/loaders";
import EndpointPageClient from "./EndpointPageClient";

/**
 * Endpoint & Key — Server Component loads keys/settings; client handles mutations.
 */
export default async function EndpointPage() {
  const initialData = await loadEndpointPage();
  return <EndpointPageClient initialData={initialData} />;
}
