import { Suspense } from "react";
import type { Metadata } from "next";

import { siteConfig } from "@/lib/site";
import { getAllFacilities } from "@/lib/data";
import { Explorer } from "@/components/explorer/explorer";

export const metadata: Metadata = {
  description: siteConfig.description,
};

/**
 * Landing page — server component.
 * Loads facilities at request time and passes them to the Explorer client component.
 */
export default function HomePage() {
  const facilities = getAllFacilities();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
      {/* Hero — atlas title block */}
      <div className="relative mb-8">
        {/* Hairline graticule background layer */}
        <div
          aria-hidden="true"
          className="graticule pointer-events-none absolute inset-0 opacity-40 [mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]"
        />

        <div className="relative space-y-3 pb-8">
          {/* Overline */}
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            United States · Edition 2026 · 39.5°N 98.5°W
          </p>

          {/* Headline */}
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
            A survey of AI datacenter infrastructure.
          </h1>

          {/* Subhead */}
          <p className="text-base text-muted-foreground leading-relaxed max-w-2xl">
            Tracking{" "}
            <span className="font-mono tabular-nums text-lg font-semibold text-foreground">
              {facilities.length}
            </span>{" "}
            AI datacenters across the United States. Data is sourced from public
            permit filings, corporate announcements, and news records. This
            tracker is non-partisan and carries no editorial position.
          </p>
        </div>

        {/* Neatline rule under hero */}
        <div className="border-t border-border" />
      </div>

      {/* Explorer: filter bar + view toggle + map/table */}
      <Suspense>
        <Explorer facilities={facilities} />
      </Suspense>
    </div>
  );
}
