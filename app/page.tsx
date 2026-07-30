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
import { HeroGlobe } from "@/components/home/hero-globe-dynamic";
import { SurveyLedger } from "@/components/home/survey-ledger";
import { ActivityList } from "@/app/activity/activity-list";

export const revalidate = 3600;

const ACTIVITY_TEASER_LIMIT = 5;

export const metadata: Metadata = {
  title: "US data center map & database",
  description: siteConfig.description,
  alternates: { canonical: "/" },
};

/**
 * Landing page — editorial frontispiece.
 * Server component: no client state needed.
 */
export default async function HomePage() {
  const { count, states, operationalMw, plannedMw, underConstructionMw } =
    await getStats();
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

  // Slim point set for the hero globe — just enough to plot + link each
  // facility, filtered defensively in case a record ever has a bad geocode.
  const heroPoints = allFacilities
    .filter(
      (f) =>
        Number.isFinite(f.location.lat) && Number.isFinite(f.location.lon)
    )
    .map((f) => ({
      id: f.id,
      lat: f.location.lat,
      lon: f.location.lon,
      status: f.status,
    }));

  const operatorCount = new Set(allFacilities.map((f) => f.operator)).size;
  const sourcesCited = allFacilities.reduce(
    (n, f) => n + (f.sources?.length ?? 0),
    0
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: datasetJsonLdString({ dateModified }) }}
      />
      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="relative mb-10 min-h-[60vh] overflow-hidden">
        {/*
         * Living globe hero — every tracked facility plotted on a
         * globe-projection basemap, drawn in west→east on load. Purely
         * decorative/progressive-enhancement: the accessible path is the
         * SSR'd H1 below and the "Explore the map →" CTA further down (to
         * the fully-accessible /map), not this canvas. `overflow-hidden`
         * above clips the absolutely-positioned globe to this box — it can
         * never bleed into the stats/links section below.
         */}
        <div className="absolute inset-0">
          <HeroGlobe points={heroPoints} heightClass="h-full" />
        </div>

        {/*
         * Parchment scrim so the cartouche stays legible over the map.
         * Scoped to the text region, not a full-hero fade: near-opaque
         * (≥92%) through 50% of the hero's height — generous headroom for
         * the overline/H1/subhead even when the subhead wraps to several
         * lines on narrow viewports — then fades to fully transparent by
         * 85%, so the globe still reads clearly in the lower part of the
         * (now taller) hero.
         */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background from-0% via-background/92 via-50% to-transparent to-85%"
        />

        <div className="relative z-10 space-y-4 pt-8 pb-10">
          {/* Overline */}
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            United States · Edition 2026 · 39.5°N 98.5°W
          </p>

          {/* Headline */}
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl max-w-4xl">
            America&rsquo;s data centers, mapped and sourced.
          </h1>

          {/* Subhead — text-foreground/85 (not text-muted-foreground): needs
              to stay legible against the map showing through the scrim. */}
          <p className="text-base text-foreground/85 leading-relaxed max-w-2xl">
            Public data on data centers is everywhere and nowhere — split across hundreds of local permits, tax abatements, water filings, and interconnection queues. Compute Atlas unifies it into a single open, source-cited map. Community-built, fully transparent, and continuously updated.
          </p>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Below the hero: stats + cross-links + primary CTA, grouped as one   */}
      {/* unit on the plain parchment page background — reads clearly as     */}
      {/* "below the hero," not "in the map."                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="border-t border-border pt-10">
        {/* Survey ledger + pipeline-scale signature */}
        <SurveyLedger
          count={count}
          states={states}
          operators={operatorCount}
          sources={sourcesCited}
          operationalMw={operationalMw}
          underConstructionMw={underConstructionMw}
          plannedMw={plannedMw}
          className="mb-10 border-b border-border pb-10"
        />

        {/* Statistics link */}
        <div className="mb-6">
          <Link
            href="/stats"
            className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            View full statistics →
          </Link>
        </div>

        {/* Crypto mining cross-link */}
        <div className="mb-6">
          <Link
            href="/crypto"
            className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            Browse crypto mining facilities →
          </Link>
        </div>

        {/* Rankings cross-link */}
        <div className="mb-6">
          <Link
            href="/rankings"
            className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            See the biggest projects, operators, and states →
          </Link>
        </div>

        {/* Learn cross-link */}
        <div className="mb-6">
          <Link
            href="/learn"
            className="inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            Learn the terms behind the dataset →
          </Link>
        </div>

        {/* Entry points */}
        <div className="mb-12 flex flex-wrap items-center gap-4">
          <Link
            href="/map"
            className="inline-flex h-11 items-center gap-2 rounded-md border border-primary bg-primary/10 px-5 font-mono text-sm font-semibold uppercase tracking-wider text-primary transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Explore the map →
          </Link>
        </div>
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
