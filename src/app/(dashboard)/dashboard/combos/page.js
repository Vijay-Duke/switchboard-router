// @ts-check
import { loadCombosPage } from "@/lib/dashboard/loaders";
import CombosPageClient from "./CombosPageClient";

/**
 * Combos — server read, client mutations / DnD.
 */
export default async function CombosPage() {
  const initialData = await loadCombosPage();
  return <CombosPageClient initialData={initialData} />;
}
