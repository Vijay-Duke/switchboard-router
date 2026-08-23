// @ts-check
import { getLocalEndpointPort } from "@/lib/appUpdater";
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
  // SSR default for chrome that displays the endpoint (Sidebar, Overview).
  // Client components re-derive from window.location after mount; this keeps
  // pre-hydration HTML correct instead of baking in a hardcoded port.
  const endpointHost = `127.0.0.1:${getLocalEndpointPort()}`;
  return (
    <QueryProvider>
      <DashboardLayout endpointHost={endpointHost}>{children}</DashboardLayout>
    </QueryProvider>
  );
}
