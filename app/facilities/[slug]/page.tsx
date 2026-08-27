import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Info } from "lucide-react";

import { getAllFacilityIds, getFacilityByIdCached, operatorSlug } from "@/lib/data";
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
import { facilityJsonLdString, breadcrumbJsonLdString } from "@/lib/seo";
import type { Facility } from "@/lib/schema";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { StatusTimeline } from "@/components/facility/status-timeline";
import { ProvenancePanel } from "@/components/facility/provenance-panel";
import { FacilityMiniMapDynamic } from "@/components/facility/facility-mini-map-dynamic";
import { CivicImpactSection, hasCivicImpact } from "@/components/facility/civic-impact";
import { StakeholdersSection, hasStakeholders } from "@/components/facility/stakeholders";
import { PowerLinksSection, hasPowerLinks } from "@/components/facility/power-links";
import { SitingContextSection, hasSitingContext } from "@/components/facility/siting-context";
import { RelatedFacilities } from "@/components/facility/related-facilities";
import { Breadcrumb } from "@/components/breadcrumb";
import { SuggestCorrection } from "@/components/contribute/suggest-correction";
import { WatchButton } from "@/components/subscribe/watch-button";

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

  return (
    <div data-content-width="4xl" className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10">
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
      <Breadcrumb items={crumbs} />

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
          <Badge variant="outline">
            {FACILITY_TYPE_META[facility.facilityType]?.label ??
              facility.facilityType}
          </Badge>
          <StatusBadge status={facility.status} className="text-base" />
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
        <dl className="neatline grid grid-cols-1 gap-x-8 gap-y-4 rounded-sm border border-border p-5 sm:grid-cols-2">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Location
            </dt>
            <dd className="mt-1 text-sm">
              {facility.location.street ? (
                <span className="block">{facility.location.street}</span>
              ) : null}
              {location}
              {facility.location.postalCode ? ` ${facility.location.postalCode}` : ""}
              {facility.location.county
                ? ` · ${formatCountyLabel(facility.location.county, facility.location.state)}`
                : ""}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Capacity
            </dt>
            <dd className="mt-1 text-sm font-mono tabular-nums">
              {formatCapacity(facility)}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Powered by
            </dt>
            <dd className="mt-1 text-sm">
              {facility.poweredBy ?? "—"}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Announced
            </dt>
            <dd className="mt-1 text-sm font-mono tabular-nums">
              {facility.announcedDate ?? "—"}
            </dd>
          </div>

          <div>
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Last updated
            </dt>
            <dd className="mt-1 text-sm font-mono tabular-nums">
              <time dateTime={facility.lastUpdated}>{facility.lastUpdated}</time>
            </dd>
          </div>
        </dl>
      </section>

      {hasSitingContext(facility) && (
        <>
          <Separator />
          <SitingContextSection facility={facility} />
        </>
      )}

      {(await hasPowerLinks(facility)) && (
        <>
          <Separator />
          <PowerLinksSection facility={facility} />
        </>
      )}

      {hasCivicImpact(facility) && (
        <>
          <Separator />
          <CivicImpactSection facility={facility} />
        </>
      )}

      {hasStakeholders(facility) && (
        <>
          <Separator />
          <StakeholdersSection facility={facility} />
        </>
      )}

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
    </div>
  );
}
