import type { ReactNode } from "react";

import { BarLabelRow } from "@/components/chart/bar-label-row";
import { BarTrack } from "@/components/chart/bar-track";

export interface StackedBandSegment {
  /** Band name, rendered verbatim as the row header of the data table. */
  label: string;
  /**
   * Magnitude for this band. Negative values are clamped to 0, and so is
   * anything non-finite. The prop type is not a runtime gate — `segments` is
   * typically built from imported JSON, whose element type is *inferred*
   * rather than checked against this interface — so a `NaN`, an `Infinity`,
   * a `null` or a stringly-typed count can still arrive. Any one of them
   * would otherwise poison the total, defeat the `total === 0` guard below,
   * and render "NaN%" with a `flex-grow` the browser discards.
   */
  count: number;
  /**
   * Segment and swatch fill. Callers pass a ramp entry from
   * `lib/map-overlays.ts` — never an invented hue — so the band reads by
   * luminance the way the map's ordinal overlays do. `undefined` (an
   * unrecognized label) degrades to a neutral fill rather than dropping the
   * band, matching `colorForLabel`'s own contract.
   */
  color?: string;
}

export interface StackedBandProps {
  /** Left-hand title above the band. */
  title: ReactNode;
  /**
   * Right-hand value text above the band. The caller composes the exact
   * format — same split as `PercentageBar`, rather than a format
   * mini-language in here. Omitting it leaves the value column empty rather
   * than collapsed; see `BarLabelRow`.
   */
  valueLabel?: ReactNode;
  /** Accessible name for the band graphic itself. */
  ariaLabel: string;
  /** `sr-only` caption naming the data table. */
  tableCaption: string;
  /** Header for the count column (e.g. "Sites"). Visually hidden. */
  countHeading?: string;
  /** Bands, in the order they should read — most-severe-first for ordinal data. */
  segments: StackedBandSegment[];
  /** Provenance / attribution line under the table. Rendered as visible text. */
  caption?: ReactNode;
  className?: string;
}

/** Fill for a band whose label has no entry in the shared ramp. */
const UNKNOWN_BAND_COLOR = "var(--muted-foreground)";

/**
 * An n-segment 100% stacked band with a legend, generalizing
 * `PercentageBar`'s single fill. Server component; the rail and the title row
 * are shared with `PercentageBar` via `BarTrack` and `BarLabelRow`.
 *
 * `PercentageBar` is deliberately NOT re-expressed as a one-segment
 * StackedBand: its fill is a PART of a visible muted track (the remainder is
 * meaningful ground), while these segments PARTITION the track, and its
 * label sits in a two-column baseline row rather than a swatched legend.
 * Collapsing them would need a synthetic remainder segment plus a
 * suppress-the-swatch flag — more configuration than the shared geometry and
 * title row, which is what `BarTrack` and `BarLabelRow` actually factor out.
 *
 * Accessibility: the band is a picture of numbers, so it carries `role="img"`
 * with a summary name and its segments are `aria-hidden`. The exact figures
 * live in a real `<table>` that is ALSO the visible legend — one data
 * structure, not a visible legend plus a duplicate `sr-only` table. That
 * avoids announcing every band twice, and avoids leaving two copies of each
 * label in the DOM for `getByText` to trip over. Color is never the only
 * channel: every swatch sits beside its name in text.
 */
export function StackedBand({
  title,
  valueLabel,
  ariaLabel,
  tableCaption,
  countHeading = "Count",
  segments,
  caption,
  className,
}: StackedBandProps) {
  const rows = segments.map((segment) => ({
    ...segment,
    // `Math.max(0, NaN)` is NaN, so a bare clamp lets a non-finite count past
    // the zero guard below. Finiteness is checked first, not coerced: a value
    // outside the documented contract is dropped from the picture rather than
    // silently joining the denominator with a guessed magnitude.
    count: Number.isFinite(segment.count) ? Math.max(0, segment.count) : 0,
  }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);

  // Nothing to picture, and every share would be 0/0. Render nothing rather
  // than a full-width empty rail or "NaN%" — the sibling of CostLedger's
  // em-dash-on-zero-denominator convention, applied to a graphic.
  if (total === 0) return null;

  const withShares = rows.map((row) => ({ ...row, pct: (row.count / total) * 100 }));
  // A zero-count band is kept in the table (0 is a finding) but drawn as no
  // segment at all — a 0%-wide segment held open by `minWidth` would claim
  // width the data does not have.
  const drawn = withShares.filter((row) => row.count > 0);

  return (
    <div className={className}>
      {/* Title row shared with PercentageBar (components/chart/bar-label-row.tsx)
          so the two never drift on alignment/gap/type scale. */}
      <BarLabelRow label={title} valueLabel={valueLabel} />
      {/*
        No explicit per-segment widths. Percentages rounded for display never
        sum to exactly 100, so laying the band out from them leaves a hairline
        of bare track at the right edge. `flex-grow: <count>` over
        `flex-basis: 0` makes the browser partition the rail exactly, at full
        precision, with no residue to absorb — the gap is closed structurally
        rather than by fudging the last segment. `minWidth` keeps a band that
        rounds to a sliver (e.g. 17 of 1,914 ≈ 0.9%) from vanishing on a
        narrow viewport; flex-grow redistributes the difference across the
        other segments, so the band still fills exactly 100%.
      */}
      <BarTrack role="img" ariaLabel={ariaLabel} className="mt-1.5 flex h-2.5">
        {drawn.map((row) => (
          <div
            key={row.label}
            aria-hidden="true"
            className="h-full"
            style={{
              flexGrow: row.count,
              flexBasis: 0,
              minWidth: "2px",
              backgroundColor: row.color ?? UNKNOWN_BAND_COLOR,
            }}
          />
        ))}
      </BarTrack>
      <table className="mt-2 w-full border-collapse text-sm">
        <caption className="sr-only">{tableCaption}</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Band</th>
            <th scope="col">{countHeading}</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {withShares.map((row) => (
            <tr key={row.label}>
              <th scope="row" className="py-0.5 pr-2 text-left font-normal">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-[1px] border border-border/40"
                    style={{ backgroundColor: row.color ?? UNKNOWN_BAND_COLOR }}
                  />
                  <span className="text-muted-foreground">{row.label}</span>
                </span>
              </th>
              <td className="py-0.5 text-right font-mono tabular-nums text-foreground">
                {row.count.toLocaleString("en-US")}
              </td>
              <td className="py-0.5 pl-3 text-right font-mono tabular-nums text-muted-foreground">
                {row.pct.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {caption ? (
        <p className="mt-2 font-mono text-[10px] leading-tight text-muted-foreground">
          {caption}
        </p>
      ) : null}
    </div>
  );
}
