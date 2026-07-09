// @ts-check
import { DashboardLayout } from "@/shared/components";
import QueryProvider from "@/shared/query/QueryProvider";

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
