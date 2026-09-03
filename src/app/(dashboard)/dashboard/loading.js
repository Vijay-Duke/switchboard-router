import { CardSkeleton } from "@/shared/components/Loading";

/**
 * Route-level loading UI for /dashboard and every nested route.
 * Next renders this automatically while the dynamic Server Component
 * payload is still being read (e.g. slow SQLite on first paint).
 */
export default function DashboardLoading() {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
      aria-busy="true"
      aria-label="Loading"
    >
      <CardSkeleton />
      <CardSkeleton />
      <CardSkeleton />
      <CardSkeleton />
      <CardSkeleton />
      <CardSkeleton />
    </div>
  );
}
