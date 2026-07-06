import Link from "next/link";
import type { Metadata } from "next";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { siteConfig } from "@/lib/site";
import { getAllFacilities } from "@/lib/data";
import { FacilityMap } from "@/components/map/facility-map-dynamic";

export const metadata: Metadata = {
  description: siteConfig.description,
};

/**
 * Landing page — server component.
 * Loads facilities at request time and passes them to the client-side map.
 */
export default function HomePage() {
  const facilities = getAllFacilities();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
      {/* Hero */}
      <div className="space-y-4 mb-8">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          {siteConfig.name}
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl">
          Tracking{" "}
          <strong className="font-semibold text-foreground">
            {facilities.length} AI datacenters
          </strong>{" "}
          across the United States. Data is sourced from public permit filings,
          corporate announcements, and news records. This tracker is
          non-partisan and carries no editorial position.
        </p>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/table"
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            View as data table
          </Link>
        </div>
      </div>

      {/* Interactive map */}
      <section id="map" aria-label="Interactive datacenter map">
        <FacilityMap facilities={facilities} />
      </section>
    </div>
  );
}
