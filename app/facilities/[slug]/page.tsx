import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Info, Flag } from "lucide-react";

import { getAllFacilityIds, getFacilityByIdCached, operatorSlug, countySlug } from "@/lib/data";
import { getStatusMeta } from "@/lib/status";
import { FACILITY_TYPE_META } from "@/lib/facility-type";
import {
  formatCapacity,
  formatLocation,
  AI_CLASSIFICATION_LABELS,
  CONFIDENCE_LABELS,
  isOperatorRedundant,
  nameConveysType,
} from "@/lib/format";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";
import { formatCountyLabel } from "@/lib/metros";
import { buildFacilityJsonLd, facilityJsonLdString, breadcrumbJsonLdString } from "@/lib/seo";
import type { Facility } from "@/lib/schema";
import { cn, QUIET_ACTION_CLASS } from "@/lib/utils";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { MastheadFactGrid, MastheadFactRow } from "@/components/facility/fact-row";
import { StatusTimeline } from "@/components/facility/status-timeline";
import { ProvenancePanel } from "@/components/facility/provenance-panel";
import { FacilityMiniMapDynamic } from "@/components/facility/facility-mini-map-dynamic";
import { CivicImpactSection } from "@/components/facility/civic-impact";
import { StakeholdersSection } from "@/components/facility/stakeholders";
import { PowerLinksSection } from "@/components/facility/power-links";
import { SitingContextSection } from "@/components/facility/siting-context";
import { RelatedFacilities } from "@/components/facility/related-facilities";
import { PrintBriefButton } from "@/components/facility/print-brief-button";
import { PrintGapSummary } from "@/components/facility/print-gap-summary";
import { PrintProvenanceFooter } from "@/components/facility/print-provenance-footer";
import { Breadcrumb } from "@/components/breadcrumb";
import { SuggestCorrection } from "@/components/contribute/suggest-correction";
import { FieldGapPrompt } from "@/components/contribute/field-gap-prompt";
import { ConfirmFactPrompt } from "@/components/contribute/confirm-fact-prompt";
import { WatchButton } from "@/components/subscribe/watch-button";
import { ShareButton } from "@/components/share-button";
import { SupportCta } from "@/components/support-cta";

export const revalidate = false;

export async function generateStaticParams() {
  const ids = await getAllFacilityIds();
  return ids.map((id) => ({ slug: id }));
}

/**
 * Lowercase, prose-friendly facility-type labels for SEO title/description
 * copy — distinct from the Title-Case `FACILITY_TYPE_META` used for the page
 * badge.
 */
const TITLE_TYPE_LABEL: Record<Facility["facilityType"], string> = {
  data_center: "data center",
  crypto_mining: "crypto-mining facility",
  power_generation: "power-generation facility",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const facility = await getFacilityByIdCached(slug);

  if (!facility) {
    return { title: "Facility not found" };
  }

  const statusLabel = getStatusMeta(facility.status).label;
  const location = formatLocation(facility);
  const typeLabel = TITLE_TYPE_LABEL[facility.facilityType] ?? "facility";

  // Title location: prefer "City, ST"; fall back to the full state name
  // (not the bare 2-letter code) when city is unknown — a bare code reads
  // poorly as the tail of a title ("... in TX").
  const { city, state } = facility.location;
  const titleLocation = city ? `${city}, ${state}` : stateNameFromCode(state) ?? state;

  // Omit the operator when it's already embedded in the facility name (or
  // vice versa, modulo legal suffixes like "Inc."/"LLC") — e.g. name
  // "Google Council Bluffs", operator "Google" — to avoid "Google Council
  // Bluffs — Google data center in ...". Likewise omit the type label when
  // the name already conveys the type — e.g. "... Bitcoin Mining Facility"
  // already says crypto-mining. Both keep titles from carrying two names
  // for the same thing; see lib/format.ts for the redundancy checks.
  const operatorRedundant = isOperatorRedundant(facility.name, facility.operator);
  const typeRedundant = nameConveysType(facility.name, facility.facilityType);

  const descriptor = [
    operatorRedundant ? null : facility.operator,
    typeRedundant ? null : typeLabel,
  ]
    .filter(Boolean)
    .join(" ");

  const title = descriptor
    ? `${facility.name} — ${descriptor} in ${titleLocation}`
    : `${facility.name} — ${titleLocation}`;

  const capacity = formatCapacity(facility);
  const hasCapacity = Boolean(capacity) && capacity !== "—";
  const description =
    `${statusLabel} ${typeLabel} in ${location}, operated by ${facility.operator}.` +
    (hasCapacity ? ` ${capacity}.` : "") +
    ` Source-cited status history and references on Compute Atlas.`;

  return { title, description, alternates: { canonical: `/facilities/${slug}` } };
}

/**
 * Facility detail page — static server component.
 *
 * Generated at build time for all facilities via generateStaticParams.
 * SEO surface and target for "View details" links from the map popup
 * and data table.
 */
export default async function FacilityPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const facility = await getFacilityByIdCached(slug);

  if (!facility) {
    notFound();
  }

  const location = formatLocation(facility);
  const capacity = formatCapacity(facility);
  // Reuses the same canonical absolute URL the page's own JSON-LD already
  // builds (buildFacilityJsonLd's `url` field), rather than hand-
  // concatenating siteConfig.url + a path a second time.
  const canonicalUrl = buildFacilityJsonLd(facility).url;
  const isProvisional =
    facility.status === "proposed" || facility.status === "permitted";
  const isRumored = facility.confidence === "rumored";
  const showBanner = isProvisional || isRumored;

  const stateName = stateNameFromCode(facility.location.state) ?? facility.location.state;
  const stateSlug = stateSlugFromCode(facility.location.state);
  const crumbs = [
    { label: "Map", href: "/map" },
    ...(stateSlug ? [{ label: stateName, href: `/states/${stateSlug}` }] : []),
    { label: facility.name },
  ];

  // data-print-brief is the hook globals.css's @media print block uses to
  // re-typeset this record as a dense stat sheet (see the print comment
  // there) — scoped to this container so other printable pages keep the
  // screen rhythm.
  return (
    <div
      data-content-width="4xl"
      data-print-brief
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: facilityJsonLdString(facility) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbJsonLdString(
            crumbs.map((c) => ({ name: c.label, url: c.href }))
          ),
        }}
      />
      {/* Screen navigation chrome — the printed brief carries its canonical
          URL in the provenance footer instead. */}
      <Breadcrumb items={crumbs} className="print:hidden" />

      {/* Plate masthead */}
      <header className="space-y-3">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          {location}
          {facility.location.county
            ? ` · ${formatCountyLabel(facility.location.county, facility.location.state)}`
            : ""}
          {" · "}
          <span
            aria-label={`Coordinates: ${facility.location.lat.toFixed(3)} degrees north, ${Math.abs(facility.location.lon).toFixed(3)} degrees west`}
          >
            {facility.location.lat.toFixed(3)}°N {Math.abs(facility.location.lon).toFixed(3)}°W
          </span>
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          {facility.name}
        </h1>
        <p className="text-base text-muted-foreground">
          <Link
            href={`/operators/${operatorSlug(facility.operator)}`}
            className="underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            {facility.operator}
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <StatusBadge status={facility.status} />
          <Badge variant="outline">
            {FACILITY_TYPE_META[facility.facilityType]?.label ??
              facility.facilityType}
          </Badge>
          {(facility.facilityType === "data_center" ||
            facility.facilityType === "crypto_mining") &&
            facility.aiClassification && (
              <Badge variant="outline">
                {AI_CLASSIFICATION_LABELS[facility.aiClassification] ??
                  facility.aiClassification}
              </Badge>
            )}
          <Badge variant="outline">
            {CONFIDENCE_LABELS[facility.confidence] ?? facility.confidence}
          </Badge>
        </div>
        <div className="border-t border-border" />
      </header>

      {/* Compact CTA strip — print trigger plus the same two actions as the
          full-size CTAs at the end of the page (SuggestCorrection /
          WatchButton below), reachable without scrolling past the whole
          record. Kept quiet (text-scale, no bordered card) so it doesn't
          compete with the H1; the bottom pair stays put as the canonical
          full-size CTA — this is additive. The strip itself is print:hidden
          and PrintBriefButton carries the variant too (belt and suspenders —
          it must never appear in the printout it produces). Every item is
          one text-sm baseline (QUIET_ACTION_CLASS) with its own
          `min-h-11` touch target and a leading icon (aria-hidden, so it
          never leaks into the accessible name), rather than a mix of
          default/sm Buttons and a bare text link at four different heights. */}
      <div className="flex flex-wrap items-center gap-x-5 print:hidden">
        <PrintBriefButton />
        <ShareButton title={facility.name} url={canonicalUrl} />
        <SuggestCorrection
          facilityId={facility.id}
          facilityName={facility.name}
          showIntro={false}
          triggerLabel={
            <>
              <Flag className="size-3.5" aria-hidden="true" />
              Spot an error?
            </>
          }
          triggerClassName={cn(
            QUIET_ACTION_CLASS,
            "inline-flex items-center gap-1.5 min-h-11"
          )}
        />
        <WatchButton
          targetType="facility"
          targetId={facility.id}
          label="Watch this facility"
          quiet
        />
      </div>

      {/* Provisional / rumored banner */}
      {showBanner && (
        <Card className="border-muted-foreground/30">
          <CardContent className="flex gap-3 pt-4">
            <Info
              className="size-4 mt-0.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="space-y-1 text-sm text-muted-foreground">
              {isProvisional && (
                <p>
                  This facility is{" "}
                  <strong className="font-medium text-foreground">
                    {facility.status}
                  </strong>{" "}
                  and has not been reported as operational. Details are based on
                  public filings and announcements as of{" "}
                  <time dateTime={facility.lastUpdated} className="tabular-nums">
                    {facility.lastUpdated}
                  </time>
                  .
                </p>
              )}
              {isRumored && (
                <p>
                  This record is marked as{" "}
                  <strong className="font-medium text-foreground">
                    rumored
                  </strong>{" "}
                  — data has not been independently confirmed.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Key facts */}
      <section aria-labelledby="key-facts-heading">
        <h2 id="key-facts-heading" className="font-display text-xl text-foreground mb-4">
          Key facts
        </h2>
        <MastheadFactGrid>
          <MastheadFactRow label="Location">
            {facility.location.street ? (
              <span className="block">{facility.location.street}</span>
            ) : null}
            {location}
            {facility.location.postalCode ? ` ${facility.location.postalCode}` : ""}
            {/* County links to its /counties hub. Deliberately carries no
                resting color or underline — only hover/focus affordances —
                so the printed stat sheet renders it as the plain text it
                replaced (a link is meaningless on paper). Same treatment as
                the operator link in the masthead above, which already sits
                inside [data-print-brief]. The masthead's county eyebrow is
                left as plain text: it is a dense mono metadata line, and one
                link per fact is enough. */}
            {facility.location.county ? (
              <>
                {" · "}
                <Link
                  href={`/counties/${countySlug(facility.location.county, facility.location.state)}`}
                  className="underline-offset-4 rounded-sm transition-colors motion-reduce:transition-none hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {formatCountyLabel(facility.location.county, facility.location.state)}
                </Link>
              </>
            ) : null}
          </MastheadFactRow>

          <MastheadFactRow label="Capacity" valueClassName="mt-1 text-sm font-mono tabular-nums">
            {capacity === "—" ? (
              <FieldGapPrompt
                field="capacityOperationalMw"
                facilityId={facility.id}
                facilityName={facility.name}
                label="the capacity"
              />
            ) : (
              <>
                {capacity}
                <div className="mt-1">
                  <ConfirmFactPrompt
                    field="capacityOperationalMw"
                    facilityId={facility.id}
                    facilityName={facility.name}
                    label="the capacity"
                    vintage={facility.lastUpdated}
                  />
                </div>
              </>
            )}
          </MastheadFactRow>

          <MastheadFactRow label="Powered by">
            {facility.poweredBy ?? (
              <FieldGapPrompt
                field="poweredBy"
                facilityId={facility.id}
                facilityName={facility.name}
                label="who powers this facility"
              />
            )}
          </MastheadFactRow>

          <MastheadFactRow label="Announced" valueClassName="mt-1 text-sm font-mono tabular-nums">
            {facility.announcedDate ?? (
              <FieldGapPrompt
                field="announcedDate"
                facilityId={facility.id}
                facilityName={facility.name}
                label="the announcement date"
              />
            )}
          </MastheadFactRow>

          <MastheadFactRow label="Last updated" valueClassName="mt-1 text-sm font-mono tabular-nums">
            <time dateTime={facility.lastUpdated}>{facility.lastUpdated}</time>
          </MastheadFactRow>
        </MastheadFactGrid>
      </section>

      <SitingContextSection facility={facility} />

      <PowerLinksSection facility={facility} />

      <CivicImpactSection facility={facility} />

      <StakeholdersSection facility={facility} />

      <Separator />

      {/* Status timeline */}
      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading" className="font-display text-xl text-foreground mb-4">
          Status history
        </h2>
        <StatusTimeline
          history={facility.statusHistory}
          sources={facility.sources}
        />
      </section>

      <Separator />

      {/* Mini map — interactive-only, not useful on a printed page */}
      <section aria-labelledby="map-heading" className="print:hidden">
        <h2 id="map-heading" className="font-display text-xl text-foreground mb-4">
          Location
        </h2>
        <FacilityMiniMapDynamic facility={facility} />
      </section>

      <Separator />

      {/* Provenance */}
      <ProvenancePanel facility={facility} />

      {/* Related facilities — same operator / same state. Renders its own
          leading Separator + heading when it has content, and nothing at
          all when both groups are empty. */}
      <RelatedFacilities facility={facility} />

      <Separator />

      {/* Correction — interactive CTA, not useful on a printed page */}
      <div className="print:hidden">
        <SuggestCorrection facilityId={facility.id} facilityName={facility.name} />
      </div>

      {/* Watch — interactive CTA, not useful on a printed page */}
      <div className="print:hidden">
        <WatchButton
          targetType="facility"
          targetId={facility.id}
          label="Watch this facility"
        />
      </div>

      <Separator />

      {/* Support — the page's closing ask. 1,064 facility pages previously
          carried none of the site's three existing SupportCta placements
          (about/support/contribute), despite being the pages an organic
          search visitor actually lands on. One honest line, no dollar
          figures, per CLAUDE.md's de-sell editorial voice; print:hidden
          since an ask has no place in the printed brief. */}
      <section aria-labelledby="support-heading" className="print:hidden space-y-3">
        <h2 id="support-heading" className="font-display text-xl text-foreground">
          Support
        </h2>
        <p className="text-sm text-muted-foreground">
          Compute Atlas is maintained by one person, source by source — if
          that&rsquo;s useful to you, a one-off tip helps keep it running.
        </p>
        <SupportCta />
      </section>

      {/* Print-only: one line naming every section this record has no data
          for. Sits immediately above the provenance footer so the sheet ends
          with what is known about the record, then what is not. */}
      <PrintGapSummary facility={facility} />

      {/* Print-only: what makes the printout citable — where it came from,
          when the record was curated, when it was printed, and the data
          licence. Must stay the LAST child of the container. */}
      <PrintProvenanceFooter
        name={facility.name}
        url={canonicalUrl}
        lastUpdated={facility.lastUpdated}
      />
    </div>
  );
}
