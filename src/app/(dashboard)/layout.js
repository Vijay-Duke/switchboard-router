// @ts-check
import { DashboardLayout } from "@/shared/components";
import QueryProvider from "@/shared/query/QueryProvider";

// Every page below reads the live SQLite DB in its Server Component. Without
// this, `next build` opens (and migrates) the operator's database and bakes
// provider/key/quota counts into the static HTML + RSC payload. Applies to all
// nested segments.
export const dynamic = "force-dynamic";

/**
 * Dashboard shell: Server Component root with client chrome + query cache.
 * @param {{ children: import("react").ReactNode }} props
 */
export default function DashboardRootLayout({ children }) {
  return (
    <QueryProvider>
      <DashboardLayout>{children}</DashboardLayout>
    </QueryProvider>
  );
}
