import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Info } from "lucide-react";

import { getAllFacilities, getFacilityById } from "@/lib/data";
import { getStatusMeta } from "@/lib/status";
import { formatCapacity, formatLocation } from "@/lib/format";
import { siteConfig } from "@/lib/site";
import { facilityJsonLdString } from "@/lib/seo";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { StatusTimeline } from "@/components/facility/status-timeline";
import { ProvenancePanel } from "@/components/facility/provenance-panel";
import { FacilityMiniMapDynamic } from "@/components/facility/facility-mini-map-dynamic";

/** Human-readable labels for the aiClassification enum. */
const AI_CLASSIFICATION_LABELS: Record<string, string> = {
  confirmed: "AI-specific",
  likely: "Likely AI-specific",
  mixed_use: "Mixed-use",
};

/** Human-readable labels for the confidence enum. */
const CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  reported: "Reported",
  rumored: "Rumored",
};

export function generateStaticParams() {
  return getAllFacilities().map((f) => ({ slug: f.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const facility = getFacilityById(slug);

  if (!facility) {
    return { title: "Facility not found" };
  }

  const statusLabel = getStatusMeta(facility.status).label;
  const location = formatLocation(facility);

  return {
    title: facility.name,
    description: `${facility.operator} — ${statusLabel} AI datacenter in ${location}. Capacity, status history, and sources on Compute Atlas.`,
  };
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
  const facility = getFacilityById(slug);

  if (!facility) {
    notFound();
  }

  const location = formatLocation(facility);
  const isProvisional =
    facility.status === "proposed" || facility.status === "permitted";
  const isRumored = facility.confidence === "rumored";
  const showBanner = isProvisional || isRumored;

  const correctionUrl = `${siteConfig.repoUrl}/issues/new?title=${encodeURIComponent(
    "Data correction: " + facility.name
  )}`;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: facilityJsonLdString(facility) }}
      />
      {/* Back link */}
      <Link
        href="/"
        className="inline-flex items-center text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
      >
        ← All facilities
      </Link>

      {/* Header */}
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          {facility.name}
        </h1>

        <p className="text-lg text-muted-foreground">{facility.operator}</p>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={facility.status} className="text-base" />
          <Badge variant="outline">
            {AI_CLASSIFICATION_LABELS[facility.aiClassification] ??
              facility.aiClassification}
          </Badge>
          <Badge variant="outline">
            {CONFIDENCE_LABELS[facility.confidence] ?? facility.confidence}
          </Badge>
        </div>
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
        <h2 id="key-facts-heading" className="text-base font-semibold mb-4">
          Key facts
        </h2>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Location
            </dt>
            <dd className="mt-1 text-sm">
              {location}
              {facility.location.county
                ? `, ${facility.location.county} County`
                : ""}
            </dd>
          </div>

          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Capacity
            </dt>
            <dd className="mt-1 text-sm tabular-nums">
              {formatCapacity(facility)}
            </dd>
          </div>

          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Powered by
            </dt>
            <dd className="mt-1 text-sm">
              {facility.poweredBy ?? "—"}
            </dd>
          </div>

          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Announced
            </dt>
            <dd className="mt-1 text-sm tabular-nums">
              {facility.announcedDate ?? "—"}
            </dd>
          </div>

          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Last updated
            </dt>
            <dd className="mt-1 text-sm tabular-nums">
              <time dateTime={facility.lastUpdated}>{facility.lastUpdated}</time>
            </dd>
          </div>
        </dl>
      </section>

      <Separator />

      {/* Status timeline */}
      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading" className="text-base font-semibold mb-4">
          Status history
        </h2>
        <StatusTimeline
          history={facility.statusHistory}
          sources={facility.sources}
        />
      </section>

      <Separator />

      {/* Mini map */}
      <section aria-labelledby="map-heading">
        <h2 id="map-heading" className="text-base font-semibold mb-4">
          Location
        </h2>
        <FacilityMiniMapDynamic facility={facility} />
      </section>

      <Separator />

      {/* Provenance */}
      <ProvenancePanel facility={facility} />

      <Separator />

      {/* Correction link */}
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          Compute Atlas is community-correctable. If you have better data,
          please open an issue.
        </p>
        <a
          href={correctionUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Suggest a correction for this facility (opens GitHub in a new tab)"
          className="inline-flex items-center text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          Suggest a correction →
        </a>
      </div>
    </div>
  );
}
