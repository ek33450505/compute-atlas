import Link from "next/link";
import type { Metadata } from "next";

import { getAllFacilities } from "@/lib/data";
import { FacilityTable } from "@/components/table/facility-table";

export const metadata: Metadata = {
  title: "Data table",
  description:
    "Accessible sortable table of all tracked AI datacenters in the United States.",
};

/**
 * /table — server component.
 * Loads all facilities at request time and renders an accessible, sortable
 * data table. This is the WCAG 2.2 AA first-class alternative to the map.
 */
export default function TablePage() {
  const facilities = getAllFacilities();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="space-y-4 mb-8">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          AI datacenter data table
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl">
          All{" "}
          <strong className="font-semibold text-foreground">
            {facilities.length} tracked facilities
          </strong>{" "}
          across the United States. Click any column header to sort. Each row
          links to the facility detail page.
        </p>

        <Link
          href="/"
          className="inline-flex items-center text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
        >
          ← View map
        </Link>
      </div>

      <section aria-label="Facilities data table">
        <FacilityTable facilities={facilities} />
      </section>
    </div>
  );
}
