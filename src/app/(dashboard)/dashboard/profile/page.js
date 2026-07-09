// @ts-check
import { loadProfilePage } from "@/lib/dashboard/loaders";
import ProfilePageClient from "./ProfilePageClient";

/**
 * Profile / settings — server read, client mutations.
 */
export default async function ProfilePage() {
  const initialData = await loadProfilePage();
  return <ProfilePageClient initialData={initialData} />;
}
