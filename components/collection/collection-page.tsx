import type { ReactNode } from "react";
import Link from "next/link";

import type { Facility } from "@/lib/schema";
import { formatCapacity, formatLocation } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb, type Crumb } from "@/components/breadcrumb";
import { CollectionJsonLd } from "@/components/collection/collection-json-ld";
import { ShowMoreList } from "@/components/collection/show-more-list";

export interface CollectionStat {
  label: string;
  value: string;
}

export interface CollectionPageProps {
  title: string;
  intro: ReactNode;
  crumbs: Crumb[];
  statRow: CollectionStat[];
  facilities: Facility[];
  /** Shown in place of the card grid when `facilities` is empty. */
  emptyMessage?: string;
}

const DEFAULT_EMPTY_MESSAGE = "No facilities currently match this view.";

/**
 * One facility card for a collection grid. Mirrors the "Notable sites" card
 * markup on the homepage (app/page.tsx) and
 * components/facility/related-facilities.tsx's RelatedFacilityCard (name /
 * operator+StatusBadge / City, ST / capacity), but formats location and
 * capacity via the shared lib/format helpers instead of re-deriving them
 * inline — so this is the one place collection pages duplicate card markup,
 * not a fourth reimplementation of the formatting logic too.
 */
function CollectionFacilityCard({ facility }: { facility: Facility }) {
  return (
    <Link
      href={`/facilities/${facility.id}`}
      className="neatline group flex flex-col gap-2 rounded-sm border border-border p-4 transition-colors motion-reduce:transition-none hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span className="font-display text-base leading-snug text-foreground group-hover:text-primary transition-colors motion-reduce:transition-none">
        {facility.name}
      </span>

      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground truncate min-w-0">
          {facility.operator}
        </span>
        <StatusBadge status={facility.status} className="shrink-0" />
      </div>

      <span className="font-mono text-xs text-muted-foreground">
        {formatLocation(facility)}
      </span>

      <span className="font-mono text-xs text-muted-foreground">
        {formatCapacity(facility)}
      </span>
    </Link>
  );
}

/**
 * Shared presentational primitive for "collection" landing pages — SEO
 * surfaces that list a filtered slice of the dataset (by status, and future
 * lenses) behind a masthead + stat row + card grid. Callers own data
 * fetching (via a cached lib/data reader) and pass already-resolved props;
 * this component only renders, so it stays trivially testable without
 * mocking the data layer.
 *
 * Injects the shared BreadcrumbList + ItemList JSON-LD pair via
 * `CollectionJsonLd` (from `crumbs` and `facilities`) — collection pages
 * don't hand-roll structured data.
 */
export function CollectionPage({
  title,
  intro,
  crumbs,
  statRow,
  facilities,
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
}: CollectionPageProps) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:py-12 space-y-8">
      <CollectionJsonLd crumbs={crumbs} facilities={facilities} />

      <Breadcrumb items={crumbs} />

      <header className="space-y-4 pb-2">
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          {title}
        </h1>
        <div className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          {intro}
        </div>
        <div className="border-t border-border" />
      </header>

      {statRow.length > 0 && (
        <div className="flex flex-wrap gap-8 border-b border-border pb-8">
          {statRow.map((stat) => (
            <div key={stat.label} className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {stat.value}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                {stat.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {facilities.length === 0 ? (
        <p className="text-base text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ShowMoreList
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          initialCount={48}
          itemLabel="facilities"
        >
          {facilities.map((f) => (
            <CollectionFacilityCard key={f.id} facility={f} />
          ))}
        </ShowMoreList>
      )}
    </div>
  );
}
