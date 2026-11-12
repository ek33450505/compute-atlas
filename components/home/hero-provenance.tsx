import { statesPhrase } from "@/lib/us-states";
import { cn } from "@/lib/utils";

interface HeroProvenanceProps {
  /**
   * The dated site count, e.g. "3,174 sites as of 12 November 2026" (`datasetCountPhrase`).
   * The date is when the data was read, so a cached value shows its true age. Null when the
   * read failed: the segment is then dropped rather than printed without a date.
   */
  sites: string | null;
  /** Two-letter codes of the jurisdictions covered, incl. `DC`. */
  stateCodes: string[];
  /** LIVE total of cited sources across all facilities. */
  sources: number;
  newThisQuarter: number;
  cancelledThisQuarter: number;
  className?: string;
}

/**
 * One mono rule of dataset provenance, sitting above the fold between the hero
 * subhead and the search box.
 *
 * Only LIVE figures belong on this line, and the site count is always dated. The static map's
 * territory omission is NOT here: it is stated in <PlateKey>, beside the plot it qualifies.
 */
export function HeroProvenance({
  sites,
  stateCodes,
  sources,
  newThisQuarter,
  cancelledThisQuarter,
  className,
}: HeroProvenanceProps) {
  const segments: string[] = [
    ...(sites === null ? [] : [sites]),
    statesPhrase(stateCodes),
    `${sources.toLocaleString("en-US")} sources`,
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
