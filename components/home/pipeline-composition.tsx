import Link from "next/link";

import { StackArea } from "@/components/chart/stack-area";
import { SectionHeading } from "@/components/section-heading";
import { STATUS_META, type Status } from "@/lib/status";
import pipelineHistory from "@/public/data/pipeline-history.json";

export interface PipelineCompositionProps {
  className?: string;
}

// Copied verbatim from cost-ledger.tsx, so every homepage prose link shares
// one appearance.
const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

const { coverage, quarters, statuses } = pipelineHistory;

/**
 * A real runtime check rather than a cast. `statuses` arrives from imported
 * JSON, whose element type is *inferred* as `string`, so a status renamed
 * upstream would otherwise index `STATUS_META` as `undefined` and throw at
 * render. An unrecognized value is dropped from the picture — the same
 * "outside the contract is dropped, not guessed" posture the chart primitive
 * takes with non-finite counts.
 */
function isStatus(value: string): value is Status {
  return value in STATUS_META;
}

/**
 * Bands in the artifact's own order — `operational` at the bottom, `cancelled`
 * at the top. Labels and colors are READ from `STATUS_META`, never retyped
 * here, so the chart cannot drift from the status chips, the map pins or the
 * lens pages.
 */
const BANDS = statuses.filter(isStatus).map((status) => ({
  label: STATUS_META[status].label,
  color: STATUS_META[status].hex,
  values: quarters.map((quarter) => quarter.counts[status]),
}));

/**
 * "2020Q1" → "2020 Q1". This is the ONLY label form the chart sees: it is what
 * `StackArea` draws on the axis AND what it renders as every table row header.
 * The raw `quarter` key is not passed down at all.
 */
const X_LABELS = quarters.map((quarter) => quarter.quarter.replace("Q", " Q"));

// `in` narrowing, not a property access: only the final element carries
// `partial`, so TypeScript infers `quarters` as a union of two shapes and a
// bare `quarter.partial` would not typecheck.
const PROVISIONAL_INDEX = quarters.findIndex(
  (quarter) => "partial" in quarter && quarter.partial === true
);

const FIRST_QUARTER = quarters[0];
const LAST_QUARTER = quarters[quarters.length - 1];

// Summed rather than read off a literal: `datePrecision` is the artifact's own
// breakdown of every dated event it consumed, so its total is the denominator
// the two imprecise counts below belong to.
const TOTAL_DATED_EVENTS =
  coverage.datePrecision.year + coverage.datePrecision.month + coverage.datePrecision.day;

const PEAK = coverage.ambiguousPeak;

const fmt = (value: number) => value.toLocaleString("en-US");

/**
 * The homepage's time axis: how many tracked facilities STOOD IN each status
 * at each quarter's end, 2020 to now. Server component — the artifact is
 * imported at build time (the pattern `cost-ledger.tsx` uses for
 * map-layers.json), never fetched: `public/data/` is served under
 * `/data/:path+` with `s-maxage=86400, stale-while-revalidate=604800`, so a
 * client fetch could serve a week-stale series behind an edge cache this plan
 * cannot purge by URL. Importing it ships the series with the deploy instead.
 *
 * ⚠️ No `"use client"` anywhere in this subtree. A client boundary here would
 * ship the whole 27-quarter artifact to the browser a second time, in the RSC
 * payload as well as the bundle.
 *
 * ⚠️ Counts, never percentages. The population being described GROWS across
 * the window, and every figure in the caption below is read off `coverage` at
 * build time rather than typed as a literal — a hardcoded share silently
 * falsifies itself on the next data wave, which has already happened once to
 * the builder script's own header comment.
 */
export function PipelineComposition({ className }: PipelineCompositionProps) {
  return (
    <section aria-labelledby="pipeline-composition-heading" className={className}>
      {/* space-y-1 wrapper + mb-6: matches cost-ledger.tsx exactly — at
          size="lg" the h2 carries no gap of its own, so the step to the
          content below has to come from this side. */}
      <div className="mb-6 space-y-1">
        <SectionHeading
          kicker="Over time"
          id="pipeline-composition-heading"
          size="lg"
          title="What the pipeline was made of"
        />
      </div>
      <p className="mt-3 max-w-2xl text-base text-muted-foreground">
        Each column is how many tracked facilities stood in each status at that
        quarter&rsquo;s end — a standing count, not a tally of announcements.
        The total height is the population itself: {fmt(FIRST_QUARTER.known)}{" "}
        facilities at {X_LABELS[0]}, {fmt(LAST_QUARTER.known)} at{" "}
        {X_LABELS[X_LABELS.length - 1]}. Most of that rise is the survey
        growing, not the buildout, which is why nothing here is drawn as a
        share.
      </p>
      <StackArea
        className="mt-8"
        bands={BANDS}
        xLabels={X_LABELS}
        provisionalIndex={PROVISIONAL_INDEX >= 0 ? PROVISIONAL_INDEX : undefined}
        provisionalNote="quarter in progress"
        ariaLabel={`Tracked facilities by status at each quarter’s end, ${X_LABELS[0]} to ${
          X_LABELS[X_LABELS.length - 1]
        }, stacked as counts rather than shares. The tracked population rises from ${fmt(
          FIRST_QUARTER.known
        )} to ${fmt(
          LAST_QUARTER.known
        )} facilities across the window. Exact counts follow in the table.`}
        tableCaption="Tracked facilities standing in each status at each quarter’s end"
        xHeading="Quarter"
        caption={
          <>
            {fmt(coverage.excludedNoHistory)} of {fmt(coverage.totalFacilities)}{" "}
            tracked facilities carry no dated status history and appear in no
            quarter at all; {fmt(coverage.withHistory)} do. The axis omits{" "}
            {/* The `where` clause has to attach to the OMITTED range, not to
                the drawn one. `knownAtStart` is the denominator at the FIRST
                DRAWN quarter, so it is a ceiling the omitted quarters never
                reach — "never reaches N" is true of all of them, where "is
                double digits" was false of the earliest (single digit) and
                described the wrong end of the range. */}
            {fmt(coverage.quartersOmitted)} earlier quarters, back to{" "}
            {coverage.earliestEvent}, where the denominator never reaches{" "}
            {fmt(coverage.knownAtStart)}.{" "}
            {X_LABELS[X_LABELS.length - 1]} is still in progress — drawn washed
            out behind a dashed rule, not as a closed quarter.
          </>
        }
      />
      <p className="mt-6 max-w-2xl text-base text-muted-foreground">
        One caveat runs the other way from the usual. Of{" "}
        {fmt(TOTAL_DATED_EVENTS)} dated status events,{" "}
        {fmt(coverage.datePrecision.year)} name only a year and{" "}
        {fmt(coverage.datePrecision.month)} only a month; each resolves to the{" "}
        <em>start</em> of the period it names, so every imprecisely dated
        transition lands earlier here than its source pins it. The series
        therefore reads as an earlier, faster buildout than the sources
        support. At the worst quarter, {PEAK.quarter.replace("Q", " Q")},{" "}
        {fmt(PEAK.count)} of {fmt(PEAK.known)} known facilities (
        {PEAK.share.toFixed(1)}%) sit in a row that choice moves. How each
        status is defined, and how these records are built, is set out in{" "}
        <Link href="/methodology" className={LINK_CLASS}>
          the methodology
        </Link>
        .
      </p>
    </section>
  );
}
