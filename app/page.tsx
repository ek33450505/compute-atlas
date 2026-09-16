import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Globe } from "lucide-react";

import { siteConfig } from "@/lib/site";
import { datasetJsonLdString } from "@/lib/seo";
import { getDatasetEdition } from "@/lib/dataset-edition";
import {
  getStats,
  getNotableFacilities,
  getRecentActivity,
  getAllFacilities,
  getCommunityReceptionCounts,
  getAiClassificationCounts,
  getFacilityTypeCounts,
  getNotableOppositionCases,
  getGenerationBuildoutStats,
  getWaterStressExposure,
  getFrictionTotal,
  getCounties,
  getQuarterlyPipelineSummary,
  selectRecordSpecimen,
} from "@/lib/data";
import { METROS } from "@/lib/metros";
import { StatusBadge } from "@/components/status-badge";
import { HeroGlobe } from "@/components/home/hero-globe-dynamic";
import { HeroPlate } from "@/components/home/hero-plate";
import { HERO_PLATE } from "@/components/home/hero-plate-paths";
import { HeroSearch } from "@/components/home/hero-search";
import { HeroProvenance } from "@/components/home/hero-provenance";
import { PlateKey } from "@/components/home/plate-key";
import { SurveyLedger } from "@/components/home/survey-ledger";
import { LensGateway } from "@/components/home/lens-gateway";
import { ContestedStrip } from "@/components/home/contested-strip";
import { CostLedger } from "@/components/home/cost-ledger";
import { PipelineComposition } from "@/components/home/pipeline-composition";
import { RecordSpecimen } from "@/components/home/record-specimen";
import { OpenRecord } from "@/components/home/open-record";

export const revalidate = 3600;

const ACTIVITY_TEASER_LIMIT = 5;

/**
 * Compact cards rendered under the record specimen in "Notable sites".
 *
 * Six, not five: it divides evenly into both of the grid's breakpoints
 * (`sm:grid-cols-2 lg:grid-cols-3`), where five left a ragged 3+2 final row on
 * desktop. That is reasoned from the class list, not confirmed in a browser.
 *
 * The fetch below asks for one MORE than this — see the call site.
 */
const NOTABLE_CARD_COUNT = 6;

/**
 * Speculation Rules for the two routes this page treats as primary onward
 * destinations: /map, the hero's solid-fill CTA (in the tree below), and
 * /explore, the lens gateway's "See every lens" link
 * (components/home/lens-gateway.tsx). Deliberately NOT the hero's second link
 * /methodology, nor the gateway's sibling /stats — both are footnote-weight
 * secondary links, and speculating every outbound route would spend bandwidth
 * on the visitor's behalf for a guess this page has no basis to make.
 *
 * Rendered as an inline <script type="speculationrules"> on THIS page only
 * (see the call site in the tree below) rather than in app/layout.tsx, so it
 * does not ride along on 3,000-odd other routes that have no such links.
 *
 * ⚠️ `prefetch`, NOT `prerender`, and for /map that is the whole decision.
 * `prerender` does not fetch a document — it loads and RUNS the page in a
 * hidden tab, JS included. /map mounts MapLibre GL (~1 MB) and immediately
 * starts pulling vector tiles from a third-party CDN. This app goes out of
 * its way to keep that off phones: components/home/hero-globe-dynamic.tsx
 * gates the globe to sm+ precisely so a phone visiting `/` never downloads
 * MapLibre at all. Prerendering /map from `/` would hand that cost straight
 * back, to every homepage visitor, on a page they have not asked for yet —
 * silently undoing the gate from a file that does not mention it. `prefetch`
 * pulls the document only: no subresources, no script execution, no tiles.
 *
 * `eagerness: "moderate"` (hover/pointer-near) rather than the list-rule
 * default of immediate: a visitor who never moves toward either link pays
 * nothing, and one who does gets the document already in cache.
 *
 * What this buys, stated honestly: speculation rules apply to DOCUMENT
 * navigations, and a <Link> click after hydration is a soft navigation that
 * never requests a document. The win is the pre-hydration click — next/link
 * renders a real <a href>, so a tap that lands before this page has hydrated
 * is a full document navigation — plus any case Next cannot keep client-side.
 * Same narrow-but-real path the @view-transition rule in globals.css covers;
 * the two are deliberately aimed at it together.
 *
 * Inline speculation rules are subject to `script-src`, which carries
 * 'unsafe-inline' in next.config.ts for Next's own bootstrap script, so the
 * enforcing CSP admits this. A future move to nonces has to cover it.
 *
 * Absent support, the script element is an unknown type and is ignored: no
 * speculation happens and navigation is exactly what it is today.
 */
const HOME_SPECULATION_RULES = JSON.stringify({
  prefetch: [{ source: "list", urls: ["/map", "/explore"], eagerness: "moderate" }],
});

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
  const edition = getDatasetEdition();
  const {
    count,
    states,
    includesDc,
    stateCodes,
    operationalMw,
    plannedMw,
    underConstructionMw,
  } = await getStats();
  // One more than we render, because the specimen below is picked by a
  // DIFFERENT rule (sources + history + capacity) and so may or may not be one
  // of these. Fetching NOTABLE_CARD_COUNT + 1 means removing it leaves at least
  // NOTABLE_CARD_COUNT either way — see `specimenCards`.
  const notable = await getNotableFacilities(NOTABLE_CARD_COUNT + 1);
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

  // Lens-gateway + cost-ledger counts — cheap derivations off the same
  // cached facility set (no new DB reads; getCommunityReceptionCounts/
  // getAiClassificationCounts/getFacilityTypeCounts/
  // getGenerationBuildoutStats/getWaterStressExposure all read the shared
  // loadFacilities() cache).
  const communityCounts = await getCommunityReceptionCounts();
  const frictionCount = getFrictionTotal(communityCounts);
  const aiCounts = await getAiClassificationCounts();
  const aiClassified =
    (aiCounts.confirmed ?? 0) + (aiCounts.likely ?? 0) + (aiCounts.mixed_use ?? 0);
  const typeCounts = await getFacilityTypeCounts();
  const cryptoCount = typeCounts.crypto_mining ?? 0;
  const utilityLinked = allFacilities.filter((f) => f.energy?.utility).length;
  // County/metro lens counts. `getCounties` reads the same memoized county
  // index the /counties hub uses, so this adds no DB work; METROS is static.
  const countyCount = (await getCounties()).length;
  const metroCount = METROS.length;
  // Hero provenance line. DB-only: with no DATABASE_URL this resolves to all
  // zeros, which HeroProvenance renders by omitting the quarter segment
  // entirely rather than claiming "+0 new this quarter".
  const quarterly = await getQuarterlyPipelineSummary();
  const buildout = await getGenerationBuildoutStats();
  const waterStressExposure = await getWaterStressExposure();
  const gasNotYetBuilt =
    buildout.gas.proposed + buildout.gas.permitted + buildout.gas.underConstruction;

  // The one record shown at near-full fidelity under "Notable sites". Derived
  // from the facility set already loaded above — no new DB read. `null` when
  // nothing meets the bar (empty dataset / no DATABASE_URL), in which case the
  // section degrades to the plain card grid it was before.
  const specimen = selectRecordSpecimen(allFacilities);
  // Cards below the specimen, minus the specimen itself so the same record is
  // not printed twice. Always NOTABLE_CARD_COUNT of them: the fetch above asks
  // for one spare, so the filter leaves exactly that many when the specimen is
  // among them and one too many when it is not — the slice floors both. BOTH
  // branches are sliced; with no specimen (empty dataset / no DATABASE_URL)
  // the unfiltered list would otherwise render the spare as a seventh card.
  const specimenCards = specimen
    ? notable.filter((f) => f.id !== specimen.id).slice(0, NOTABLE_CARD_COUNT)
    : notable.slice(0, NOTABLE_CARD_COUNT);

  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: datasetJsonLdString({ dateModified }) }}
      />
      {/* See HOME_SPECULATION_RULES above for why this is prefetch rather
          than prerender, and why it lives on this page and not the layout. */}
      <script
        type="speculationrules"
        dangerouslySetInnerHTML={{ __html: HOME_SPECULATION_RULES }}
      />
      {/* min-height is responsive: on phones the globe is replaced by a
          shorter static plate (h-[40vh], see hero-globe-dynamic.tsx), so
          reserving a full 60vh here would hand that saving straight back as
          dead space above the fold. Below sm the box floors just under the
          plate and otherwise sizes to the real content — overline, H1,
          subhead, search, CTAs. sm+ is unchanged.

          `flex flex-col` is load-bearing and belongs to <PlateKey> below: it
          is what lets that card's `sm:mt-auto` absorb whatever slack this box
          has and settle on its bottom edge without leaving flow. Don't strip
          it, and don't give the cartouche column `flex-1` — see the comment
          at the <PlateKey> call site for the overlap that caused. */}
      <div className="relative mb-10 flex min-h-[46vh] flex-col overflow-hidden sm:min-h-[60vh]">
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
        {/*
         * The static dot plate is rendered HERE, on the server, and passed
         * into the client wrapper as an already-rendered node. Importing it
         * inside that `"use client"` wrapper instead would pull
         * components/home/hero-plate-paths (~23 KB raw / ~5 KB brotli of path
         * data) into the eagerly-loaded client chunk, duplicating data that is
         * already inline in this page's HTML — the same per-visitor cost the
         * point set was moved to a CDN artifact to avoid, and paid by the same
         * phones. Keep the import on this side of the boundary.
         */}
        {/* `hero-plate-vt` carries `view-transition-name: hero-plate` (see
            globals.css). It is on THIS wrapper rather than the hero box or
            the cartouche because this element is out of flow, decorative and
            has no absolutely-positioned descendants that escape it, so
            whatever containment a UA applies to a named element cannot reach
            the scrim's `-z-10`-inside-`z-10` stacking documented below. Read
            that rule's comment before moving the class: it also records that
            this fires on document navigation only, not on a <Link> click. */}
        <div className="hero-plate-vt absolute inset-0">
          <HeroGlobe heightClass="h-full" plate={<HeroPlate />} />
        </div>

        {/*
         * `relative z-10` here is load-bearing, and it is the class the
         * cartouche's scrim actually depends on. `z-10` + `relative` makes
         * THIS element a stacking context, which is what traps the scrim's
         * `-z-10` inside the hero block: the scrim paints behind its own
         * siblings but still in FRONT of <HeroGlobe> above. Strip the `z-10`
         * and the scrim escapes to the nearest ancestor stacking context and
         * paints behind the globe instead, leaving the cartouche unbacked
         * over live map tiles. Pinned by app/page.test.tsx.
         */}
        <div className="relative z-10 space-y-4 pt-8 pb-10">
          {/*
           * Cartouche — the bare text (overline, H1, subhead, provenance
           * rule) and, as an absolutely-positioned child of THIS wrapper, the
           * parchment scrim that keeps it legible over the map.
           *
           * The invariant: the scrim is sized by the text block it protects,
           * not by the hero box. It therefore needs no measurement, scales
           * with the copy on its own, and is independent of what renders
           * behind it — including whether a map draws at a given viewport.
           * Every stop below is relative to this wrapper's own height, so an
           * edit to the H1 or subhead cannot leave the lower text unbacked.
           *
           * The search field and the CTA row stay OUTSIDE it deliberately:
           * they paint their own opaque backgrounds (bg-card and solid
           * bg-primary) and are legible over the map unaided, and a scrim
           * stretched to cover them was measured burying everything except
           * the Gulf — which defeats the point of plotting the sites behind
           * the cartouche.
           *
           * -z-10 with NO `isolate` here is load-bearing: it keeps the scrim
           * below every sibling in the block above, so the tail that bleeds
           * past the text dissolves behind the search card instead of
           * veiling it. The top and side bleed is clipped by the hero's
           * overflow-hidden.
           */}
          <div className="relative space-y-4">
            {/*
             * The fade is anchored in PIXELS, not percentages. Percentage
             * stops make the opaque band a function of the copy's height, so
             * every rewording silently moved it — the exact coupling this
             * structure exists to remove. A fixed offset from the scrim's own
             * bottom edge is scale-INVARIANT: the stop lands in the same place
             * relative to the text at every content height.
             *
             * Why the constant is 24px and not the 40px `-bottom-10`
             * advertises: this element is the FIRST of five children of a
             * `space-y-4` wrapper, and Tailwind v4 compiles `space-y-4` to
             * `margin-block-end: 1rem` on `:where(& > :not(:last-child))` —
             * which includes this scrim. An absolutely-positioned box with
             * BOTH `top` and `bottom` set and `height: auto` resolves its
             * height through the offset equation (CSS 2.1 §10.6.4), and that
             * margin is subtracted from it:
             *
             *     height = H + 40 (top) + 40 (bottom) - 16 (margin) = H + 64
             *
             * so the real bottom bleed below the text is 24px, not 40. Ending
             * the opaque region at `calc(100% - 24px)` therefore puts it
             * exactly on the text block's bottom edge: all of the copy sits in
             * the fully opaque region at every height, and the fade occupies
             * only the bare bleed below it.
             *
             * ⚠️ Do NOT "restore" this to 40px to match `-bottom-10`, and do
             * not reintroduce percentage stops. Either change pushes the fade
             * ~16px up into <HeroProvenance>, the lowest-contrast text on the
             * page: --muted-foreground (#5C5344) needs alpha >= 0.825 over a
             * dark backdrop to hold 4.5:1, and the satellite basemap makes a
             * near-black backdrop reachable. If the `space-y-4` above ever
             * changes, re-derive this constant from the equation, don't guess.
             *
             * `-inset-x-4` is load-bearing, not decoration: without a
             * horizontal offset pair an absolutely-positioned box shrink-wraps
             * its content instead of spanning the wrapper, so removing it
             * collapses the scrim's width rather than trimming its bleed. The
             * extra 16px per side is deliberate headroom that the hero's
             * `overflow-hidden` currently clips — keep it.
             *
             * `hero-scrim` paints nothing of its own. It is a hook for one
             * media query in globals.css that answers to EITHER
             * `prefers-reduced-transparency: reduce` or `prefers-contrast:
             * more` — the two conditions share a block because they want the
             * identical thing for different reasons — and swaps the gradient
             * for SOLID --background. It does not touch the stops derived
             * above, and it matches only when the reader has asked the OS for
             * one of those, so the default rendering is unchanged.
             */}
            <div
              aria-hidden="true"
              className="hero-scrim pointer-events-none absolute -inset-x-4 -top-10 -bottom-10 -z-10 bg-[linear-gradient(to_bottom,var(--background)_0,var(--background)_calc(100%_-_24px),transparent_100%)]"
            />

            <p className="font-mono text-xs uppercase tracking-widest text-primary">
              {`United States · Edition v${edition.version} · 39.5°N 98.5°W`}
            </p>

            {/* Three display steps, largest first: this h1 (5xl→7xl), the
                homepage section h2s (SectionHeading size="lg", 3xl→4xl), then
                card titles. The page used to run 4xl→5xl against a flat 2xl
                everywhere below it, which is one step of hierarchy, not three.

                max-w-4xl stays: the copy is 45 characters, so at lg:text-7xl
                (72px) it sets to two lines inside a 56rem box — a narrower
                measure would break it to three and start orphaning words.
                `text-wrap: balance` (globals.css @layer base) evens those two
                lines out.

                font-display-wonk is display-scale only — see the utility's
                comment in globals.css for why it sets SOFT/WONK and
                deliberately not opsz or wght. */}
            <h1 className="font-display font-display-wonk text-5xl leading-[1.05] text-foreground sm:text-6xl lg:text-7xl max-w-4xl">
              America&rsquo;s data centers, mapped and sourced.
            </h1>

            {/* Subhead — text-foreground/85 (not text-muted-foreground): needs
                to stay legible against the map showing through the scrim.
                max-w-xl (not max-w-2xl) so it reads as a caption under the H1
                rather than a second column of body copy. */}
            <p className="text-base text-foreground/85 leading-relaxed max-w-xl">
              Public data on data centers is everywhere and nowhere — scattered
              across local permits, tax abatements, water filings, and grid
              queues. Compute Atlas pulls it into one source-cited dataset.
            </p>

            {/* Provenance rule — deliberately ABOVE the search box, not below
                the CTA: the scale and sourcing of the dataset is the claim this
                page is making, so it has to be inside the fold. */}
            <HeroProvenance
              sites={count}
              stateCodes={stateCodes}
              sources={sourcesCited}
              editionAsOf={edition.asOf}
              newThisQuarter={quarterly.newThisQuarter}
              cancelledThisQuarter={quarterly.cancelledThisQuarter}
              /* The plate's territory omission, stated in durable visible text.
                 The plate's own accessible name cannot carry it: that element
                 is replaced by the (aria-hidden) globe on desktop, so the
                 disclosure would come and go with the mount. */
              mapOmitted={HERO_PLATE.omitted}
            />
          </div>

          {/* Gazetteer search — the first next step for a first-time
              visitor; opens the same ⌘K command palette rendered in the
              header (see components/search/command-palette.tsx). */}
          <HeroSearch facilityCount={count} className="max-w-2xl" />

          {/* Primary CTA — the accessible next step this hero's own comment
              above already claimed existed. Deliberately the only BUTTON
              here: the candidate that was rejected was a second "browse all
              sites" link, which was a straight duplicate of the header's
              Table nav, and two competing buttons blunt the primary one.
              That objection was about duplication, not about ever having a
              second action — "How this is sourced" is differentiated (it
              answers "why should I believe this?", which nothing else in the
              fold does) and is styled as a quiet text link precisely so it
              reads as a footnote to the primary button rather than a rival
              to it. Keep any future addition to that test: differentiated,
              and visually subordinate.

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

            <Link
              href="/methodology"
              className="inline-flex min-h-11 items-center rounded-sm bg-background/85 px-2 backdrop-blur-sm font-mono text-sm text-foreground underline-offset-4 transition-colors motion-reduce:transition-none hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {/* min-h-11 (44px), not padding: the sibling map CTA is h-11, so
                  this matches its touch target and its baseline in the flex row
                  without gaining a button's visual weight. The arrow is
                  aria-hidden for the same reason the map CTA's ArrowRight is —
                  otherwise the accessible name is announced as "How this is
                  sourced right arrow".

                  bg-background/85 + backdrop-blur-sm + px-2 is a BACKING, not
                  decoration — do not strip it. Its two siblings in the fold
                  paint their own opaque fills (the map CTA is solid bg-primary,
                  HeroSearch's root is bg-card), so the cartouche scrim above
                  deliberately stops short of this row. This link paints
                  nothing, so on sm+ it sits directly over live MapLibre tiles —
                  land, water, roads and status-coloured dots. --foreground
                  #2B2721 computes to 13.15:1 against parchment #F5F1E6, and
                  that audit ASSUMES parchment behind it; over tiles the
                  effective ratio is still unknown and lower — the backing is
                  what the reader actually has, not the token. That caveat is
                  exactly why this link was darkened from --muted-foreground
                  (#5C5344, 6.70:1) on Ed's read of the live page: it does not
                  measure the over-tiles case, it raises its FLOOR, roughly
                  doubling the headroom the 85% backing has to give away.

                  Hover shifts to --primary (#3F5B43, 6.672:1) rather than
                  keeping `hover:text-foreground`, which is now the rest state
                  and would be a dead class. It is the house pattern for a
                  text-foreground link (app/counties/page.tsx,
                  app/facilities/[slug]/page.tsx) and it keeps
                  `transition-colors` meaning something. Note the direction:
                  hover LOWERS contrast here, which is only acceptable because
                  it is transient, still clears AA on parchment, and arrives
                  with `hover:underline` — a non-colour affordance that carries
                  the interactive signal on its own. This is the
                  same treatment .maplibregl-ctrl-scale gets in globals.css
                  (85% background + a blur) and that the map's own quiet
                  overlays already use in Tailwind form
                  (components/map/facility-map.tsx). px-2 so the plate reads as
                  a soft backing rather than a tight box; it is still a text
                  link, not a second button. */}
              How this is sourced <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>

        {/* The dot plate's key — the legend that makes its status colours
            decodable, and a one-line caption of what the plate drew.

            Rendered HERE, as a sibling of the globe/plate box, and NOT inside
            <HeroPlate> or the `plate` node handed to <HeroGlobe>: that whole
            node is swapped out for the aria-hidden globe canvas on sm+ once
            MapLibre mounts, so a key living in it would vanish at exactly the
            viewports where the map is richest. Same reason the territory
            disclosure sits on <HeroProvenance> rather than on the plate's
            accessible name.

            ⚠️ A direct child of the HERO BOX, deliberately — NOT of the
            `relative z-10` cartouche column above. The hero box is the flex
            column (`flex flex-col` on it), and only a direct child of it can
            claim its free space; nested inside the cartouche column this card
            would be laid out against the column's content box instead, which
            has no slack to give, and the corner placement silently stops
            meaning what it says.

            The mechanism is FLOW, not absolute positioning. The card is an
            ordinary flex item and `sm:mt-auto` absorbs ALL free space above
            it. Tall viewport ⇒ the box is taller than its content, the auto
            margin eats the slack, and the card lands on the hero's bottom
            edge (`sm:mb-4` off it) as a cartographic corner key floating over
            the plate/globe. Short viewport ⇒ the content already fills the
            box, the auto margin resolves to zero, and the card simply follows
            the CTA row. It cannot overlap anything at any viewport height
            because it never leaves flow — structurally impossible, not merely
            unlikely.

            That distinction is a recorded failure, not a preference. This
            card was first pinned `sm:absolute sm:bottom-4 sm:left-4`, and it
            overlapped the CTA row and search field on every viewport where
            the cartouche column filled the box. The box is `min-h`, so its
            height is max(60vh, column height): once the column (~440-450px)
            reaches 60vh there is NO bottom slack at all. A 1440x900 laptop
            (~750px viewport ⇒ 60vh ≈ 450px) is exactly that case, and the
            ~180px card pinned `bottom-4` landed ~60-120px INSIDE the primary
            CTA. Bottom-LEFT did not help, because the CTA row is left-aligned
            too. Do not reintroduce absolute positioning to "guarantee" the
            corner — the corner is not the invariant here, non-overlap is.

            Two layouts, ONE element — never render it twice:
            • sm+: shrink-wrapped and pushed to the hero box's bottom edge by
              the auto margin, over the globe. A real cartographic corner key
              (Ed, live browser, 2026-09-15 — the earlier full-width in-flow
              card read as hero furniture).
            • below sm: full width, directly under the column, with no auto
              margin. Deliberate, and also moot: a 5-row key is ~180-220px
              tall and at 390x844 the hero box already sizes to its content
              past `min-h-[46vh]`, so there is no slack for `mt-auto` to
              absorb even if it applied. The column's `pb-10` is the gap.
              `hidden sm:block` is not an option either: phones are where the
              plate is the ONLY map (hero-globe-dynamic.tsx gates MapLibre to
              sm+).

            ⚠️ CSS 2.1 §10.6.4 (the trap the scrim comment above derives
            `calc(100% - 24px)` from) does NOT engage here, and both halves of
            that are checked rather than assumed: the hero box carries no
            `space-y-*` at all, and this element is no longer absolutely
            positioned, so the offset equation that subtracts a sibling margin
            has nothing to bite on. Keep it that way — re-pinning this card
            with BOTH `top` and `bottom` set walks straight back into it.
            Moving it out of the column did cost the CTA row its
            `margin-block-end` (the CTA row is the new `:last-child`), which
            is harmless: the scrim's constant is a function of the INNER
            `relative space-y-4` wrapper's five children, not the outer
            column's.

            The hero box becoming a flex container changes nothing for its
            other two children. The globe wrapper is `absolute inset-0` and so
            out of flow entirely (an abspos child is not a flex item). The
            cartouche column stretches to full width exactly as it did as a
            block, and must keep `flex-grow: 0` — no `flex-1`, no `grow`. The
            slack belongs to THIS card; handing it to the column puts the
            overlap back.

            z-20 clears both the globe wrapper (`absolute inset-0`, no
            z-index) and the cartouche column (`z-10`); a `relative` flex item
            with a z-index participates in the same stacking context it did
            before, so the paint order is unchanged. The card now holds no
            focusable content at all — its map link was removed as a duplicate
            of the hero's primary "Explore the map" CTA — so it sits outside
            the tab order entirely and adds no stop between the CTA row and
            what follows.

            `sm:w-fit` + `sm:max-w-xs` (20rem) is a ceiling, no longer the
            binding constraint. It was sized for a ~115-character caption that
            no longer exists: the caption is now one short line and, on sm+,
            the `<ul>` stacks vertically, so max-content is set by the longest
            badge label ("Under construction") and resolves well inside 20rem.
            The cap is kept rather than dropped because it can only ever
            narrow this card, never widen it — cheap insurance against a
            future longer label reading as a banner across the hero's
            lower-left. `w-fit` is what keeps it shrink-wrapped now that the
            parent is a flex container: `align-items` defaults to `stretch`,
            but stretch applies only to an `auto` cross size and
            `width: fit-content` is definite — so an `sm:self-start` beside it
            would be pure redundancy and is deliberately absent. Below sm the
            width stays `auto` and that same stretch gives the full-width card.

            No left inset: in flow the card's left edge aligns with the H1 and
            the CTA row above it rather than sitting 16px in from the hero's
            border, which is the stronger alignment — `sm:left-4` was
            deliberately NOT translated into an `sm:ml-4`.

            The shadow is the popup treatment from globals.css
            (`.atlas-popup .maplibregl-popup-content`, the "soft, warm float
            shadow" third layer) reused verbatim — same tokens, same values,
            no new token. Only its drop half: the inset neatline duplicates
            what `border-border` already draws here. `sm:`-gated because below
            sm the card is in flow on flat parchment and floats over nothing.

            `plotted` is total MINUS omitted — facilities the plate draws
            ground for. Never HERO_PLATE.plotted, which counts drawn marks
            and under-counts facilities wherever co-located same-status sites
            collapse onto one.

            It is also the card's ONLY number, deliberately. The snapshot's
            own total used to sit here too ("1,920 of 1,929"), a few lines
            under <HeroProvenance>'s `sites={count}` — which is live Neon.
            Equal today, contradictory the first time a sync lands without a
            plate rebuild. The build-time artifact describes what it drew; the
            dataset total is stated once, above, from the database. */}
        <PlateKey
          plotted={HERO_PLATE.total - HERO_PLATE.omitted}
          className="relative z-20 sm:mt-auto sm:mb-4 sm:w-fit sm:max-w-xs sm:shadow-[0_6px_20px_-8px_color-mix(in_oklab,var(--foreground)_30%,transparent)]"
        />
      </div>

      {/* Below the hero: stats + cross-links + primary CTA, grouped as one
          unit on the plain parchment page background — reads clearly as
          "below the hero," not "in the map." */}
      <div className="border-t border-border pt-10 plate-reveal">
        {/* Survey ledger + pipeline-scale signature */}
        <SurveyLedger
          count={count}
          states={states}
          includesDc={includesDc}
          stateCodes={stateCodes}
          operators={operatorCount}
          sources={sourcesCited}
          operationalMw={operationalMw}
          underConstructionMw={underConstructionMw}
          plannedMw={plannedMw}
          className="mb-10 border-b border-border pb-10"
        />

        {/* Cost ledger — the counterweight: what the buildout takes, paired
            visually with the survey ledger directly above it */}
        <CostLedger
          fossilPlannedMw={buildout.fossilPlannedMw}
          nonFossilPlannedMw={buildout.nonFossilPlannedMw}
          gasNotYetBuilt={gasNotYetBuilt}
          gasTotal={buildout.gas.total}
          waterStressRated={waterStressExposure.rated}
          waterStressHighOrExtreme={waterStressExposure.highOrExtreme}
          className="mb-10 border-b border-border pb-10"
        />

        {/* Pipeline composition over time — the standing counts behind the
            ledgers above. Placement is provisional: U10 reorders this page. */}
        <PipelineComposition className="mb-10 border-b border-border pb-10" />

        {/* Lens gateway — the ways in */}
        <LensGateway
          className="mt-2"
          counts={{
            sites: count,
            states,
            includesDc,
            stateCodes,
            utilityLinked,
            frictionCount,
            aiClassified,
            operators: operatorCount,
            plannedGw: Math.round(plannedMw / 1000),
            cryptoCount,
            metros: metroCount,
            counties: countyCount,
          }}
        />
      </div>

      <div className="plate-reveal">
        {/* Raw h2 rather than SectionHeading: this one has no § kicker and no
            wrapping <section aria-labelledby>, so it does not fit that
            component's contract. Size matches SectionHeading's `lg` step by
            hand so it does not read a rank below its homepage siblings. */}
        <h2 className="font-display text-3xl sm:text-4xl text-foreground mb-5">
          Notable sites
        </h2>

        <RecordSpecimen facility={specimen} count={count} className="mb-4" />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {specimenCards.map((f) => {
            const cap =
              f.capacityMw?.operational ?? f.capacityMw?.planned ?? null;
            return (
              <Link
                key={f.id}
                href={`/facilities/${f.id}`}
                className="neatline plate-hover group flex flex-col gap-2 rounded-sm border border-border p-4 transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
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

                <span className="font-mono text-xs text-muted-foreground">
                  {f.location.city ? `${f.location.city}, ` : ""}
                  {f.location.state}
                </span>

                {cap !== null && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {cap >= 1000
                      ? `${(cap / 1000).toFixed(1)} GW`
                      : `${cap} MW`}
                  </span>
                )}

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

      {/* Contested sites — the differentiator.

          `defer-offscreen` (globals.css) — these last two sections are the
          only ones on this page that are unambiguously off-screen at first
          paint at every viewport, which is the criterion: the hero, the two
          ledgers, the lens gateway and the notable-sites grid can all be
          partly in view on a tall desktop, and skipping work the reader is
          about to look at costs a frame for nothing.

          ⚠️ The class itself lives on a wrapper INSIDE the component, not in
          the class list below, because `content-visibility: auto` also paint-
          contains the element and would clip the card grid's focus rings; the
          wrapper reserves 8px for them and this section keeps its full-width
          `border-t`. Only `--defer-h` is passed from here — it is a custom
          property, so it inherits down to that wrapper, which keeps the
          derivation below next to the markup it was derived from. See
          components/home/contested-strip.tsx and the utility's comment.

          --defer-h is the CONTENT-box height, derived from this section's
          real markup at lg (the `pt-10` and the 1px top border are outside
          it): heading block ~60 + `mt-3` lead paragraph over two lines ~60 +
          `mt-3` findings paragraph over five lines ~132 + `mt-6` three-up
          case grid ~182 (p-4 card: 2-line title 44, gap-2, location 16,
          gap-2, 3-line clamped note 48) + `mt-6` trailing link 68 = ~502px,
          taken to 520. The same markup at 390px stacks the grid to one
          column and runs ~940px; see the utility's comment for why the
          desktop figure is the right one to ship and why `auto` in front of
          the length makes it matter for the first pass only. */}
      <ContestedStrip
        cases={oppositionCases}
        frictionCount={frictionCount}
        breakdown={{
          litigation: communityCounts.litigation ?? 0,
          opposed: communityCounts.opposed ?? 0,
          contested: communityCounts.contested ?? 0,
        }}
        className="mt-12 border-t border-border pt-10 plate-reveal [--defer-h:520px]"
      />

      {/* A living, open record — provenance, contribute, recent activity.

          --defer-h derived the same way at lg: heading ~60 + `mt-3` lead over
          three lines ~84 + `mt-6` four-up provenance grid ~147 (p-4 card:
          10px label 13, mt-1, text-lg value 28, mt-1, 2-line sub 40) + `mt-8`
          contribute CTA 76 (min-h-11) + `mt-10` activity block 332 (`mb-5`
          heading row 48, then ACTIVITY_TEASER_LIMIT = 5 `py-3` rows of ~48
          plus 4 divider hairlines) = ~699px, taken to 700. ~1,400px at 390px
          wide, where every grid collapses to one column and the activity rows
          wrap. Same split as the section above: `defer-offscreen` sits on a
          wrapper inside components/home/open-record.tsx, and only the
          inherited `--defer-h` is set here. */}
      <OpenRecord
        sources={sourcesCited}
        recentActivity={recentActivity}
        className="mt-12 border-t border-border pt-10 plate-reveal [--defer-h:700px]"
      />
    </div>
  );
}
