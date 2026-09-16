import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { StatusTimeline } from "@/components/facility/status-timeline";
import { formatCapacity, formatLocation } from "@/lib/format";
import { safeExternalHref } from "@/lib/url";
import type { Facility } from "@/lib/schema";
import { cn } from "@/lib/utils";

/**
 * How many of the facility's cited sources the specimen shows. The record is a
 * demonstration, not the full provenance panel — the facility page carries all
 * of them. Taken as the FIRST N in the curated array order, which is the same
 * order `ProvenancePanel` lists them in, so the two never disagree about which
 * citation comes first. Deliberately not "pick the press ones" or "the newest":
 * any reordering rule would make the homepage assert an editorial ranking of
 * sources that the data does not carry.
 */
const SPECIMEN_SOURCE_LIMIT = 3;

interface RecordSpecimenProps {
  /**
   * The pinned specimen from `selectRecordSpecimen` (lib/data.ts), or `null`
   * when no facility meets the bar — an empty dataset, or a local render with
   * no `DATABASE_URL`. Null renders NOTHING, so the caller degrades to its
   * plain card grid rather than framing an empty box.
   */
  facility: Facility | null;
  /**
   * LIVE facility count from `getStats()`, for the caption. Passed in rather
   * than written as a literal: the caption's whole claim is that the figures on
   * this page are current, and a hardcoded count would go stale at the next
   * publish on the one component that says every field traces to a citation.
   */
  count: number;
  className?: string;
}

/**
 * One facility rendered at near-full fidelity on the homepage — name, operator,
 * status, coordinates, capacity, its first few citations as real outbound
 * links, and its status timeline. The site's thesis is "source-cited"; before
 * this, `/` showed no citation anywhere.
 *
 * ⚠️ `source.retrievedAt` is WHEN WE FETCHED THE PAGE, not when the outlet
 * published it (see the field's comment in lib/schema.ts, which records that a
 * looser rule once let publication dates be entered in its place). It is
 * therefore rendered behind an explicit "Retrieved:" label, in the same wording
 * `ProvenancePanel` uses, and never in a byline position or a bare
 * `Outlet, 14 Sep 2026` format that would read as "published on". Rendering a
 * retrieval date as a publication date on the one component whose purpose is
 * demonstrating citation rigor would be self-refuting. Do not "tidy" the label
 * away.
 */
export function RecordSpecimen({ facility, count, className }: RecordSpecimenProps) {
  if (!facility) return null;

  const { location } = facility;
  const sources = facility.sources.slice(0, SPECIMEN_SOURCE_LIMIT);

  return (
    <div
      className={cn(
        "neatline rounded-sm border border-border p-5 sm:p-6",
        className
      )}
    >
      <h3 className="font-display text-2xl leading-snug text-foreground sm:text-3xl">
        <Link
          href={`/facilities/${facility.id}`}
          className="transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          {facility.name}
        </Link>
      </h3>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-muted-foreground">
          {facility.operator}
        </span>
        <StatusBadge status={facility.status} />
      </div>

      {/* Mono fact line — location, coordinates, capacity. The coordinate
          format and its spoken aria-label match the compact cards below so the
          two read as the same record type at two levels of detail. */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs tabular-nums text-muted-foreground">
        <span>{formatLocation(facility)}</span>
        <span
          aria-label={`Coordinates: ${location.lat.toFixed(3)} degrees North, ${Math.abs(location.lon).toFixed(3)} degrees West`}
        >
          {location.lat.toFixed(3)}°N {Math.abs(location.lon).toFixed(3)}°W
        </span>
        <span>{formatCapacity(facility)}</span>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <h4 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Sources
          </h4>
          <ul className="mt-2 space-y-2.5" aria-label="Cited sources">
            {sources.map((source, i) => (
              <li key={i} className="space-y-0.5">
                {/* Outbound-link treatment copied from ProvenancePanel: same
                    safeExternalHref guard, same target/rel, same "(opens in new
                    tab)" accessible name. */}
                <a
                  href={safeExternalHref(source.url)}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`${source.label} (opens in new tab)`}
                  className="inline-flex items-start gap-1.5 text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  <ExternalLink
                    className="size-3 shrink-0 translate-y-1"
                    aria-hidden="true"
                  />
                  {source.label}
                </a>

                <div className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-muted-foreground">
                  {/* `publisher` is optional. When it is absent we show only the
                      retrieval date — the outlet name is NOT derived from the
                      URL's hostname, because a hostname is not a publisher and
                      inventing one here would fabricate an attribution. */}
                  {source.publisher && <span>{source.publisher}</span>}
                  <span>
                    Retrieved:{" "}
                    <time dateTime={source.retrievedAt} className="tabular-nums">
                      {source.retrievedAt}
                    </time>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h4 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Status history
          </h4>
          <div className="mt-2">
            <StatusTimeline
              history={facility.statusHistory}
              sources={facility.sources}
              compact
            />
          </div>
        </div>
      </div>

      <p className="mt-5 border-t border-border pt-4 font-mono text-xs tabular-nums text-muted-foreground">
        One of {count.toLocaleString("en-US")}. Every field traces to a citation.
      </p>
    </div>
  );
}
