import type { Metadata } from "next";

import { loadFacilities } from "@/lib/data";
import { FacilityAdminTable } from "@/app/admin/facilities/facility-table";

// Cookie-gated (proxy.ts matches /admin/:path*) — no anonymous visitor can ever
// receive this page, so prerendering it at build time and regenerating it every
// hour bought nothing. Measured 7.60 MB prerendered HTML on a 3600s ISR timer,
// the largest artifact in the build. Render on demand for the one authenticated
// maintainer instead.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin — Facilities",
};

/**
 * /admin/facilities — the admin facility list. Server component fetches the
 * full facility set directly (no HTTP round-trip) and hands it to the client
 * table, which mirrors `components/table/facility-table.tsx`'s TanStack Table
 * column-def + sort pattern, plus row actions (edit/delete) this admin view
 * needs that the public `/table` view does not.
 */
export default async function AdminFacilitiesPage() {
  const facilities = await loadFacilities();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-foreground">Facilities</h1>
        <p className="text-sm text-muted-foreground">
          {facilities.length} tracked facilities. Edit or delete a record, or
          add a new one.
        </p>
      </header>

      <FacilityAdminTable facilities={facilities} />
    </div>
  );
}
