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

  return (
    <p className={cn("font-mono text-xs tabular-nums text-muted-foreground", className)}>
      {segments.join(" · ")}
    </p>
  );
}
