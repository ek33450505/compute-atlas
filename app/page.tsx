import Link from "next/link";
import type { Metadata } from "next";

import { siteConfig } from "@/lib/site";
import { datasetJsonLdString } from "@/lib/seo";
import {
  getStats,
  getNotableFacilities,
  getRecentActivity,
  getAllFacilities,
} from "@/lib/data";
import { StatusBadge } from "@/components/status-badge";
import { GraticuleSurvey } from "@/components/home/graticule-survey";
import { ActivityList } from "@/app/activity/activity-list";

export const revalidate = 3600;

const ACTIVITY_TEASER_LIMIT = 5;

export const metadata: Metadata = {
  description: siteConfig.description,
};

/**
 * Landing page — editorial frontispiece.
 * Server component: no client state needed.
 */
export default async function HomePage() {
  const { count, states, operationalMw, plannedMw } = await getStats();
  const notable = await getNotableFacilities(6);
  const recentActivity = await getRecentActivity(ACTIVITY_TEASER_LIMIT);

  // Max lastUpdated across the dataset, as an ISO string, for the Dataset
  // JSON-LD's dateModified. Falls back to omitting the field if the dataset
  // is empty or every lastUpdated value fails to parse.
  const allFacilities = await getAllFacilities();
  const maxLastUpdatedMs = allFacilities.reduce((max, f) => {
    const ms = new Date(f.lastUpdated).getTime();
    return Number.isNaN(ms) ? max : Math.max(max, ms);
  }, 0);
  const dateModified =
    maxLastUpdatedMs > 0 ? new Date(maxLastUpdatedMs).toISOString() : undefined;

  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: datasetJsonLdString({ dateModified }) }}
      />
      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="relative mb-10">
        {/* Hairline graticule background layer — self-surveyed draw-in on load */}
        <GraticuleSurvey className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]" />

        <div className="relative space-y-4 pb-10">
          {/* Overline */}
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            United States · Edition 2026 · 39.5°N 98.5°W
          </p>

          {/* Headline */}
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl max-w-4xl">
            America&rsquo;s data centers, mapped and sourced.
          </h1>

          {/* Subhead */}
          <p className="text-base text-muted-foreground leading-relaxed max-w-2xl">
            The record is public but scattered across a hundred agencies — permits, tax abatements, water filings, interconnection queues. Compute Atlas gathers it into a single open, source-cited map, built and kept honest by the people who use it. Anyone can add a facility, correct a figure, or supply a missing source.
          </p>
        </div>

        {/* Neatline rule under hero */}
        <div className="border-t border-border" />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Survey stats row                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-10 flex flex-wrap gap-8 border-b border-border pb-10">
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {count}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Sites tracked
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {states}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            States covered
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {(operationalMw / 1000).toFixed(1)} GW
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Operational
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {(plannedMw / 1000).toFixed(0)} GW
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Planned pipeline
          </span>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Statistics link                                                     */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-6">
        <Link
          href="/stats"
          className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          View full statistics →
        </Link>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Entry points                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-12 flex flex-wrap items-center gap-4">
        <Link
          href="/map"
          className="inline-flex h-11 items-center gap-2 rounded-md border border-primary bg-primary/10 px-5 font-mono text-sm font-semibold uppercase tracking-wider text-primary transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Explore the map →
        </Link>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Notable sites                                                       */}
      {/* ------------------------------------------------------------------ */}
      <div>
        <h2 className="font-display text-2xl text-foreground mb-5">
          Notable sites
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {notable.map((f) => {
            const cap =
              f.capacityMw?.operational ?? f.capacityMw?.planned ?? null;
            return (
              <Link
                key={f.id}
                href={`/facilities/${f.id}`}
                className="neatline group flex flex-col gap-2 rounded-sm border border-border p-4 transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {/* Name */}
                <span className="font-display text-base leading-snug text-foreground group-hover:text-primary transition-colors">
                  {f.name}
                </span>

                {/* Operator + status row */}
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground truncate min-w-0">
                    {f.operator}
                  </span>
                  <StatusBadge status={f.status} className="shrink-0" />
                </div>

                {/* Location */}
                <span className="font-mono text-xs text-muted-foreground">
                  {f.location.city ? `${f.location.city}, ` : ""}
                  {f.location.state}
                </span>

                {/* Capacity */}
                {cap !== null && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {cap >= 1000
                      ? `${(cap / 1000).toFixed(1)} GW`
                      : `${cap} MW`}
                  </span>
                )}

                {/* Coordinates */}
                <span
                  aria-label={`Coordinates: ${f.location.lat.toFixed(3)} degrees North, ${Math.abs(f.location.lon).toFixed(3)} degrees West`}
                  className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  {f.location.lat.toFixed(3)}°N{" "}
                  {Math.abs(f.location.lon).toFixed(3)}°W
                </span>
              </Link>
            );
          })}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Recent activity teaser                                              */}
      {/* ------------------------------------------------------------------ */}
      {recentActivity.length > 0 && (
        <div className="mt-12 border-t border-border pt-10">
          <div className="mb-5 flex items-center justify-between gap-4">
            <h2 className="font-display text-2xl text-foreground">
              Recent activity
            </h2>
            <Link
              href="/activity"
              className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              View all →
            </Link>
          </div>
          <ActivityList entries={recentActivity} />
        </div>
      )}
    </div>
  );
}
