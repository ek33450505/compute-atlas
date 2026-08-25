import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Globe } from "lucide-react";

import { siteConfig } from "@/lib/site";
import { datasetJsonLdString } from "@/lib/seo";
import {
  getStats,
  getNotableFacilities,
  getRecentActivity,
  getAllFacilities,
  getCommunityReceptionCounts,
  getAiClassificationCounts,
  getFacilityTypeCounts,
  getNotableOppositionCases,
} from "@/lib/data";
import { StatusBadge } from "@/components/status-badge";
import { HeroGlobe } from "@/components/home/hero-globe-dynamic";
import { HeroSearch } from "@/components/home/hero-search";
import { SurveyLedger } from "@/components/home/survey-ledger";
import { LensGateway } from "@/components/home/lens-gateway";
import { ContestedStrip } from "@/components/home/contested-strip";
import { OpenRecord } from "@/components/home/open-record";

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
  const oppositionCases = await getNotableOppositionCases(3);

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

  const operatorCount = new Set(allFacilities.map((f) => f.operator)).size;
  const sourcesCited = allFacilities.reduce(
    (n, f) => n + (f.sources?.length ?? 0),
    0
  );

  // Lens-gateway counts — cheap derivations off the same cached facility set
  // (no new DB reads; getCommunityReceptionCounts/getAiClassificationCounts/
  // getFacilityTypeCounts all read the shared loadFacilities() cache).
  const communityCounts = await getCommunityReceptionCounts();
  const frictionCount =
    (communityCounts.contested ?? 0) +
    (communityCounts.opposed ?? 0) +
    (communityCounts.litigation ?? 0);
  const aiCounts = await getAiClassificationCounts();
  const aiClassified =
    (aiCounts.confirmed ?? 0) + (aiCounts.likely ?? 0) + (aiCounts.mixed_use ?? 0);
  const typeCounts = await getFacilityTypeCounts();
  const cryptoCount = typeCounts.crypto_mining ?? 0;
  const utilityLinked = allFacilities.filter((f) => f.energy?.utility).length;

  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: datasetJsonLdString({ dateModified }) }}
      />
      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                                */}
      {/* ------------------------------------------------------------------ */}
      {/* min-height is responsive: on phones the globe is replaced by a
          shorter static plate (h-[40vh], see hero-globe-dynamic.tsx), so
          reserving a full 60vh here would hand that saving straight back as
          dead space above the fold. Below sm the box floors just under the
          plate and otherwise sizes to the real content — overline, H1,
          subhead, search, CTAs. sm+ is unchanged. */}
      <div className="relative mb-10 min-h-[46vh] sm:min-h-[60vh] overflow-hidden">
        {/*
         * Living globe hero — every tracked facility plotted on a
         * globe-projection basemap, drawn in west→east on load. Purely
         * decorative/progressive-enhancement: the accessible path is the
         * SSR'd H1 below and the "Explore the map →" CTA further down (to
         * the fully-accessible /map), not this canvas. `overflow-hidden`
         * above clips the absolutely-positioned globe to this box — it can
         * never bleed into the stats/links section below.
         *
         * The point set is deliberately NOT passed down from here: it is a
         * static artifact (public/data/hero-points.json, built by
         * scripts/build-hero-points.mjs) that the client wrapper fetches
         * after mount, on sm+ only. Serializing ~1k points into this server
         * payload instead cost every visitor — phones included — ~98 KB
         * brotli for a surface phones never render.
         */}
        <div className="absolute inset-0">
          <HeroGlobe heightClass="h-full" />
        </div>

        {/*
         * Parchment scrim so the cartouche stays legible over the map.
         * Scoped to the text region, not a full-hero fade: near-opaque
         * (≥92%) through 58% of the hero's height — enough for the overline,
         * H1 and subhead even when the subhead wraps on narrow viewports —
         * then fully transparent by 85%.
         *
         * The stops are set by the BARE TEXT only. The search field and the
         * CTA below it paint their own opaque backgrounds (bg-card and solid
         * bg-primary), so they are legible over the map without help; sizing
         * the scrim to cover them too was measured at 70%/95% and buried
         * everything except the Gulf, which defeats the point of plotting
         * 1,034 sites behind the cartouche.
         *
         * Measured (Playwright, against the live DOM) — subhead bottom as a
         * share of this box: desktop 1280px = 52.7%, inside the 58% band.
         * Phones measure 71%, i.e. past it — but that is NOT a legibility bug
         * today, because below `sm` the globe never mounts at all
         * (hero-globe-dynamic.tsx) and the static plate it is replaced by
         * ends around 51%, so the lower text sits on bare parchment with
         * nothing behind it to compete with.
         *
         * ⚠️ That makes these stops COUPLED to the mobile globe gate: if the
         * globe is ever allowed to render below `sm`, the bottom ~13% of the
         * subhead lands over live map tiles and this needs a responsive
         * near-opaque stop (roughly `via-76% sm:via-58%`).
         */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background from-0% via-background/92 via-58% to-transparent to-85%"
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
            Public data on data centers is everywhere and nowhere — split across hundreds of local permits, tax abatements, water filings, and interconnection queues. Compute Atlas unifies it into a single open, source-cited map. Open data, open corrections, and a public source behind every record.
          </p>

          {/* Gazetteer search — the first next step for a first-time
              visitor; opens the same ⌘K command palette rendered in the
              header (see components/search/command-palette.tsx). */}
          <HeroSearch facilityCount={count} className="max-w-2xl" />

          {/* Primary CTA — the accessible next step this hero's own comment
              above already claimed existed. Deliberately the ONLY button
              here: a second "browse all sites" link duplicated the header's
              Table nav, and competing CTAs blunt the primary one.

              Solid --primary (not the bg-primary/10 tint it started as):
              a 10% sage wash on parchment reads as a disabled/ghost control,
              which is not what the single most important action on the page
              should look like. primary-foreground #F5F1E6 on primary
              #3F5B43 computes to 6.672:1 — comfortably past this repo's
              4.5:1 bar, matching the ratio already recorded in globals.css.
              Note this grades as NORMAL text, not large: the label is
              text-sm (14px) at font-semibold (600), and WCAG's large-text
              threshold needs >=18.66px, or >=14px AND >=700 weight. So this
              is AA, not AAA — don't reuse the pair somewhere AAA is
              required. */}
          <div className="flex flex-wrap items-center gap-4">
            <Link
              href="/map"
              className="group inline-flex h-11 items-center gap-2.5 rounded-sm border border-primary bg-primary px-5 font-mono text-sm font-semibold uppercase tracking-wider text-primary-foreground shadow-sm transition-colors motion-reduce:transition-none hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Globe aria-hidden="true" className="size-4 shrink-0" />
              Explore the map
              <ArrowRight
                aria-hidden="true"
                className="size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              />
            </Link>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Below the hero: stats + cross-links + primary CTA, grouped as one   */}
      {/* unit on the plain parchment page background — reads clearly as     */}
      {/* "below the hero," not "in the map."                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="border-t border-border pt-10 plate-reveal">
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

        {/* Lens gateway — the ways in */}
        <LensGateway
          className="mt-2"
          counts={{
            sites: count,
            states,
            utilityLinked,
            frictionCount,
            aiClassified,
            operators: operatorCount,
            plannedGw: Math.round(plannedMw / 1000),
            cryptoCount,
          }}
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Notable sites                                                       */}
      {/* ------------------------------------------------------------------ */}
      <div className="plate-reveal">
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

      {/* Contested sites — the differentiator */}
      <ContestedStrip
        cases={oppositionCases}
        frictionCount={frictionCount}
        breakdown={{
          litigation: communityCounts.litigation ?? 0,
          opposed: communityCounts.opposed ?? 0,
          contested: communityCounts.contested ?? 0,
        }}
        className="mt-12 border-t border-border pt-10 plate-reveal"
      />

      {/* A living, open record — provenance, contribute, recent activity */}
      <OpenRecord
        sources={sourcesCited}
        recentActivity={recentActivity}
        className="mt-12 border-t border-border pt-10 plate-reveal"
      />
    </div>
  );
}
