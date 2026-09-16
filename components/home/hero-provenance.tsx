import { statesPhrase } from "@/lib/us-states";
import { cn } from "@/lib/utils";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Formats an ISO-8601 timestamp as `15 Sep 2026`.
 *
 * Deliberately hand-rolled rather than `toLocaleDateString()`: a bare
 * locale-less call resolves against the host's default locale, which differs
 * between the Node test runner and a browser, so the same input renders
 * differently in test and in production. Returns the input unchanged when it
 * isn't parseable — `getDatasetEdition()` falls back to the literal string
 * `"unknown"` when `facilities.meta.json` is malformed, and rendering that is
 * better than rendering `Invalid Date`.
 */
export function formatEditionDate(isoDate: string): string {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
}

interface HeroProvenanceProps {
  /** LIVE facility count, read from Neon via `getStats()` — not a snapshot figure. */
  sites: number;
  /** Two-letter codes of the jurisdictions covered, incl. `DC`. */
  stateCodes: string[];
  /** LIVE total of cited sources across all facilities. */
  sources: number;
  /** `DatasetEdition.asOf` — the last published SNAPSHOT export, not "now". */
  editionAsOf: string;
  newThisQuarter: number;
  cancelledThisQuarter: number;
  /**
   * Facilities the hero's static Albers USA plate cannot place — `omitted`
   * from components/home/hero-plate-paths, passed in by app/page.tsx.
   *
   * Passed as a NUMBER rather than imported here on purpose: importing the
   * artifact would put ~23 KB of path data one `"use client"` away from this
   * component forever after, and nothing about a provenance rule should carry
   * that risk. Omitted (and the segment dropped) when there is nothing to
   * disclose, for the same reason the quarter segment is.
   */
  mapOmitted?: number;
  className?: string;
}

/**
 * One mono rule of dataset provenance, sitting above the fold between the hero
 * subhead and the search box.
 *
 * ⚠️ The date is labelled `edition`, never "updated" / "last updated".
 * `editionAsOf` is `DatasetEdition.asOf`, which describes the last published
 * snapshot export — Neon moves ahead of it between publishes (see the interface
 * doc on `DatasetEdition` in `lib/dataset-edition.ts`). Calling it "updated"
 * would assert that the LIVE data is only as fresh as the snapshot, which is
 * exactly the misreading that type was written to prevent. For the same reason
 * `edition.recordCount` is never rendered here: the only count on this line is
 * the live `sites` figure. Do not "tidy" either of these.
 */
export function HeroProvenance({
  sites,
  stateCodes,
  sources,
  editionAsOf,
  newThisQuarter,
  cancelledThisQuarter,
  mapOmitted,
  className,
}: HeroProvenanceProps) {
  const segments: string[] = [
    `${sites.toLocaleString("en-US")} sites`,
    statesPhrase(stateCodes),
    `${sources.toLocaleString("en-US")} sources`,
    `edition ${formatEditionDate(editionAsOf)}`,
  ];

  // Omit the quarter entirely when nothing moved — "+0 new this quarter" reads
  // as a finding when it is really an absence (and is what an unset
  // DATABASE_URL degrades to, where it would be a lie).
  // A quarter with cancellations but no additions renders the cancellations
  // ALONE: "+0 new this quarter, 2 cancelled" would state the same false
  // finding the omission above exists to avoid, just with a real fact bolted
  // onto it. Do not collapse this back into a two-way ternary.
  if (newThisQuarter > 0 || cancelledThisQuarter > 0) {
    const newPhrase = `+${newThisQuarter.toLocaleString("en-US")} new this quarter`;
    const quarter =
      newThisQuarter === 0
        ? `${cancelledThisQuarter.toLocaleString("en-US")} cancelled this quarter`
        : cancelledThisQuarter > 0
          ? `${newPhrase}, ${cancelledThisQuarter.toLocaleString("en-US")} cancelled`
          : newPhrase;
    segments.push(quarter);
  }

  // The hero plate's own disclosure of this is TRANSIENT — the plate is an
  // <svg role="img"> that MapLibre replaces with an aria-hidden canvas the
  // moment the globe mounts, so on desktop its accessible name is announced or
  // not purely on timing. This rule is always on the page at every viewport,
  // so the omission is stated here instead, as visible text.
  //
  // "static map" is deliberate: it is a fact about that artifact, true whether
  // or not the globe has replaced it on screen (the globe plots the territories
  // fine — it is the Albers USA projection that cannot). The wording is also
  // why hero-plate.test.tsx asserts every omitted code is a real US territory:
  // a data wave that omitted something else would make this line false, and
  // that test is what fails instead of shipping it.
  if (mapOmitted !== undefined && mapOmitted > 0) {
    segments.push(
      mapOmitted === 1
        ? "static map omits 1 in a U.S. territory"
        : `static map omits ${mapOmitted.toLocaleString("en-US")} in U.S. territories`
    );
  }

  return (
    <p className={cn("font-mono text-xs tabular-nums text-muted-foreground", className)}>
      {segments.join(" · ")}
    </p>
  );
}
