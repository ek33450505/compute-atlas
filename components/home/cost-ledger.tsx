import Link from "next/link";

import { formatPower, formatRatio } from "@/lib/format";
import { SurveyStatRow } from "@/components/survey-stat-row";

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
  // Same em-dash-on-zero-denominator convention, applied to a percent instead
  // of a ratio — waterStressRated === 0 would otherwise divide by zero and
  // render "NaN%".
  const waterStressPct =
    waterStressRated === 0
      ? "—"
      : `${Math.round((waterStressHighOrExtreme / waterStressRated) * 100)}%`;

  return (
    <section aria-labelledby="cost-ledger-heading" className={className}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        § What it takes
      </p>
      <h2
        id="cost-ledger-heading"
        className="mt-1 font-display text-2xl text-foreground"
      >
        The other side of the ledger
      </h2>
      <SurveyStatRow
        spacing="wide"
        stats={[
          { value: formatPower(fossilPlannedMw), label: "Gas · planned" },
          { value: ratioLabel, label: "Gas to non-fossil" },
          { value: waterStressPct, label: "Sites in stressed basins" },
        ]}
      />
      <p className="mt-3 max-w-2xl text-base text-muted-foreground">
        Of the generation being built specifically to serve compute,{" "}
        {formatPower(fossilPlannedMw)} of planned capacity is natural gas,
        against {formatPower(nonFossilPlannedMw)} for every non-fossil
        technology combined. {gasNotYetBuilt} of the {gasTotal} tracked gas
        plants are not built yet — the most carbon-intensive option on the
        table is still the one being chosen, in proceedings that are still
        open.
      </p>
      <p className="mt-3 max-w-2xl text-base text-muted-foreground">
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
