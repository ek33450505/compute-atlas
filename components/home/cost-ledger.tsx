import Link from "next/link";

import { formatPower, formatRatio } from "@/lib/format";
import {
  colorForWaterStressLabel,
  orderedWaterStressDistribution,
} from "@/lib/map-overlays";
import mapLayers from "@/public/data/map-layers.json";
import { StackedBand } from "@/components/chart/stacked-band";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { SectionHeading } from "@/components/section-heading";

export interface CostLedgerProps {
  fossilPlannedMw: number;
  nonFossilPlannedMw: number;
  /** proposed + permitted + underConstruction — tracked gas plants not yet built. */
  gasNotYetBuilt: number;
  gasTotal: number;
  waterStressRated: number;
  waterStressHighOrExtreme: number;
  className?: string;
}

// Copied verbatim from the in-prose link className just added to
// contested-strip.tsx, so every homepage prose link shares one appearance.
const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * The six-band baseline-water-stress histogram already built into
 * public/data/map-layers.json by `npm run build:mapdata` and, until now,
 * rendered nowhere but the map's Layers legend. Ordering and colors come from
 * lib/map-overlays.ts — the same source the map paints from, so the band and
 * the overlay can't disagree — and unrecognized labels degrade to a neutral
 * swatch instead of dropping a band.
 *
 * ⚠️ This is a BUILD-TIME artifact and the prose below it counts LIVE Neon
 * rows (`waterStressRated` / `waterStressHighOrExtreme`), so the two
 * denominators legitimately differ today and will drift further after any
 * `db:sync`. Rather than let two unqualified totals sit a few lines apart,
 * the band names its own basis in both its visible value line and its
 * caption ("map-overlay snapshot"), and the prose keeps its own wording
 * ("tracked sites with basin data"). Deriving the histogram from live data
 * instead would need a new aggregate query in lib/data.ts; the snapshot is
 * what the plan asked to surface.
 */
const WATER_STRESS_SEGMENTS = orderedWaterStressDistribution(
  mapLayers.waterStress.distribution
).map(({ label, count }) => ({
  label,
  count,
  color: colorForWaterStressLabel(label),
}));

// Summed from the segments actually rendered rather than read off the
// artifact's own `total`: if a band label were renamed upstream, `total`
// would keep counting it while the band could not draw it, and the figure
// beside the band would silently overstate what the picture shows.
const WATER_STRESS_SITES = WATER_STRESS_SEGMENTS.reduce(
  (sum, segment) => sum + segment.count,
  0
);

/**
 * The counterweight to `SurveyLedger`: what the buildout costs, not just how
 * much of it exists. Server component — presentational and prop-driven like
 * every sibling in `components/home/`; `app/page.tsx` does the fetching.
 * Deliberately does not animate (unlike SurveyLedger's count-up) — a
 * count-up on a harm figure would be tasteless.
 */
export function CostLedger({
  fossilPlannedMw,
  nonFossilPlannedMw,
  gasNotYetBuilt,
  gasTotal,
  waterStressRated,
  waterStressHighOrExtreme,
  className,
}: CostLedgerProps) {
  const ratioLabel = formatRatio(fossilPlannedMw, nonFossilPlannedMw);
  const waterStressSitesLabel = WATER_STRESS_SITES.toLocaleString("en-US");

  return (
    <section aria-labelledby="cost-ledger-heading" className={className}>
      {/* space-y-1 wrapper: see contested-strip.tsx for why the kicker/h2 gap
          lives here rather than inside SectionHeading.

          `mb-6` rather than a margin on the row itself: SurveyStatRow takes no
          className and its class string is pinned by a regression test, so the
          gap has to come from this side. 6 (24px) matches the heading→grid step
          the sibling homepage sections use (open-record.tsx's fact `<ul>`,
          contested-strip.tsx's case `<ul>`) — a row of 4xl figures is a block
          of structured content, not the `mt-3` prose step. At size="lg" the h2
          is text-3xl/sm:text-4xl and carried NO gap at all here, so on a phone
          the figures sat directly under it (Ed, iPhone QA, 2026-09-15). */}
      <div className="mb-6 space-y-1">
        <SectionHeading
          kicker="What it takes"
          id="cost-ledger-heading"
          size="lg"
          title="The other side of the ledger"
        />
      </div>
      <SurveyStatRow
        spacing="wide"
        stats={[
          { value: formatPower(fossilPlannedMw), label: "Gas · planned" },
          { value: ratioLabel, label: "Gas to non-fossil" },
        ]}
      />
      {/* The homepage's one versal, and the site's second (app/about/page.tsx
          has the other). Classes deliberately mirror that one — including
          `leading-relaxed`, which the drop cap needs: the initial is 3.1em on
          a 0.72 line-height, so at the default 1.5 leading it crowds the two
          lines it floats beside.

          ⚠️ `.drop-cap` is `::first-letter`, and ::first-letter absorbs any
          punctuation PRECEDING the first letter. This copy opens on a literal
          capital "O" in a plain text node, which is the case the rule was
          designed for. If this sentence is ever rewritten to open on a digit,
          an opening quote, or a formatPower interpolation, the versal sets a
          numeral or a quote mark instead of a letter — at which point the
          class should come off rather than be worked around. */}
      <p className="drop-cap mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">
        Of the generation being built specifically to serve compute,{" "}
        {formatPower(fossilPlannedMw)} of planned capacity is natural gas,
        against {formatPower(nonFossilPlannedMw)} for every non-fossil
        technology combined. {gasNotYetBuilt} of the {gasTotal} tracked gas
        plants are not built yet — the most carbon-intensive option on the
        table is still the one being chosen, in proceedings that are still
        open.
      </p>
      {/* Sits directly above the water-stress paragraph, not up in the stat
          row: SurveyStatRow's tiles are a centred 4xl figure over a one-line
          mono caption, and a full-width band with a six-row legend is not
          that shape. Bending the row to hold it would have distorted a
          primitive with fourteen other call sites. `StackedBand` renders
          nothing at all when the histogram is empty, so no wrapper needs a
          guard here. */}
      <StackedBand
        className="mt-8 max-w-md"
        title="Baseline water stress"
        valueLabel={`${waterStressSitesLabel} sites · map snapshot`}
        ariaLabel={`Baseline water stress of ${waterStressSitesLabel} sites in the map-overlay snapshot, most severe band first. Exact counts follow in the table.`}
        tableCaption="Sites by WRI Aqueduct baseline water-stress band, most severe first"
        countHeading="Sites"
        segments={WATER_STRESS_SEGMENTS}
        caption={`Map-overlay snapshot, not the live count · ${mapLayers.waterStress.attribution}`}
      />
      <p className="mt-6 max-w-2xl text-base text-muted-foreground">
        {waterStressRated > 0 && (
          <>
            {waterStressHighOrExtreme.toLocaleString("en-US")} of the{" "}
            {waterStressRated.toLocaleString("en-US")}{" "}
            tracked sites with basin data sit where the WRI already rates
            baseline water stress high or extremely high. That describes the
            surrounding basin, not any one facility&rsquo;s measured water use.
            Whether it matters at a given site depends on how that site
            cools, and most operators do not disclose it.
          </>
        )}{" "}
        More on{" "}
        <Link href="/power" className={LINK_CLASS}>
          the power buildout
        </Link>
        {" and "}
        <Link href="/learn/data-center-water-use" className={LINK_CLASS}>
          how much water data centers use
        </Link>
        .
      </p>
    </section>
  );
}
