import type { ReactNode } from "react";

export interface StackAreaBand {
  /** Band name, rendered verbatim in the legend and as a column header of the data table. */
  label: string;
  /**
   * Band fill. Callers pass a token from a shared palette (`lib/status.ts`'s
   * `STATUS_META[...].hex`, a `lib/map-overlays.ts` ramp entry) — never an
   * invented hue — so the chart cannot drift from the rest of the site.
   * `undefined` (an unrecognized label) degrades to a neutral fill rather
   * than dropping the band, matching `StackedBand`'s contract.
   */
  color?: string;
  /**
   * One magnitude per x position, in `xLabels` order. Negative values are
   * clamped to 0, and so is anything non-finite. The prop type is not a
   * runtime gate — `bands` is typically built from imported JSON, whose
   * element type is *inferred* rather than checked against this interface —
   * so a `NaN`, an `Infinity`, a `null` or a stringly-typed count can still
   * arrive. Any one of them would otherwise poison the running total, defeat
   * the `total === 0` guard below, and emit `NaN` into a polygon's `points`,
   * which the browser discards silently. A short array is treated the same
   * way: the missing tail reads as 0 rather than as a gap the geometry has
   * no way to draw.
   */
  values: number[];
}

export interface StackAreaProps {
  /**
   * Bands in stacking order, FIRST at the bottom. The caller owns that order
   * — typically the source artifact's own ordering — so the picture and the
   * table cannot disagree about what sits under what.
   */
  bands: StackAreaBand[];
  /** One label per x position. Every one appears in the table; the axis draws a sample. */
  xLabels: string[];
  /** Accessible name for the plot itself — a summary, since the exact figures are tabulated. */
  ariaLabel: string;
  /** `sr-only` caption naming the data table. */
  tableCaption: string;
  /** Header for the x column of the table (e.g. "Quarter"). Visually hidden. */
  xHeading?: string;
  /**
   * Index of a position whose value is PROVISIONAL — a period still in
   * progress. Drawn washed out behind a dashed rule and annotated in the
   * table, rather than dropped: omitting it would understate the present,
   * and drawing it flush would assert a closed period the data does not have.
   */
  provisionalIndex?: number;
  /** Table annotation for the provisional row, appended to its row header. */
  provisionalNote?: string;
  /** Provenance / caveat text under the chart. Rendered as visible text. */
  caption?: ReactNode;
  className?: string;
}

/** Fill for a band whose caller supplied no color. Mirrors `StackedBand`. */
const UNKNOWN_BAND_COLOR = "var(--muted-foreground)";

// User-space geometry. The SVG carries no pixel width — it scales to its
// container via `viewBox` + `w-full h-auto`, and `preserveAspectRatio`
// defaults to uniform scaling, so the dashed provisional rule keeps its
// stroke weight instead of being stretched into a wedge.
const VIEW_W = 720;
const VIEW_H = 260;
const PAD_TOP = 14;
const PAD_RIGHT = 10;
const PAD_BOTTOM = 26;
const PAD_LEFT = 46;
const PLOT_W = VIEW_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM;

/**
 * At most this many x labels are drawn on the axis. A long series (27
 * quarters) cannot label every position without overlapping, and rotating
 * them to fit trades legibility for density. The sampled ticks are for
 * orientation only — every position is named in the data table, which is the
 * authoritative surface.
 */
const MAX_TICKS = 6;

/** Evenly sampled indices, always including the first and last. */
function tickIndices(n: number): number[] {
  if (n <= MAX_TICKS) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (MAX_TICKS - 1);
  return Array.from(
    new Set(Array.from({ length: MAX_TICKS }, (_, i) => Math.round(i * step)))
  );
}

/**
 * A stacked AREA chart over an ordered series — inline SVG, presentational
 * and prop-driven, no client JS.
 *
 * ⚠️ Deliberately NOT normalised to 100%. This is the sibling of
 * `StackedBand`, which pictures a composition at ONE moment and can safely
 * divide by its own total. Over time the total is itself the finding: when
 * the population being described grows, a share can shift purely because
 * newly-tracked records skew one way. Rescaling every column to full height
 * would hide exactly that, so the bands carry raw magnitudes and the stack's
 * total height rises with the denominator. A `percent`/`stacked100` mode is
 * not an option this component should grow.
 *
 * Accessibility: the plot is a picture of numbers, so it carries `role="img"`
 * with a summary name and every element inside it is `aria-hidden`. The exact
 * figures live in a real `<table>` that is `sr-only` — unlike `StackedBand`,
 * whose table doubles as the visible legend, because a 27-row table is not a
 * legend. The visible legend is therefore a separate short list, which does
 * mean each band label appears twice in the DOM (legend + table column
 * header); tests should scope to one or use `getAllByText`. Color is never
 * the only channel: every swatch sits beside its name in text, and the
 * provisional period is marked by a dashed rule AND by words.
 */
export function StackArea({
  bands,
  xLabels,
  ariaLabel,
  tableCaption,
  xHeading = "Period",
  provisionalIndex,
  provisionalNote,
  caption,
  className,
}: StackAreaProps) {
  const n = xLabels.length;

  // Finiteness is checked first, not coerced: a value outside the documented
  // contract is dropped from the picture rather than silently joining the
  // stack with a guessed magnitude. `Math.max(0, NaN)` is NaN, so a bare
  // clamp would let it past the zero guard below.
  const rows = bands.map((band) => ({
    label: band.label,
    color: band.color ?? UNKNOWN_BAND_COLOR,
    values: Array.from({ length: n }, (_, i) => {
      const value = band.values[i];
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    }),
  }));

  const totals = Array.from({ length: n }, (_, i) =>
    rows.reduce((sum, row) => sum + row.values[i], 0)
  );
  const grandTotal = totals.reduce((sum, value) => sum + value, 0);
  const max = totals.reduce((hi, value) => Math.max(hi, value), 0);

  // Nothing to picture, and every y would be 0/0. Render nothing rather than
  // an empty frame — the same convention as `StackedBand`.
  if (n === 0 || grandTotal === 0 || max === 0) return null;

  // cumulative[k][i] = sum of bands 0..k at position i — the TOP edge of band
  // k. Band k's bottom edge is cumulative[k-1], or the baseline for k = 0.
  const cumulative: number[][] = [];
  rows.forEach((row, k) => {
    const below = k === 0 ? null : cumulative[k - 1];
    cumulative.push(row.values.map((value, i) => (below ? below[i] + value : value)));
  });

  const xAt = (i: number) =>
    PAD_LEFT + (n === 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W);
  const yAt = (value: number) => PAD_TOP + PLOT_H - (value / max) * PLOT_H;
  const baselineY = PAD_TOP + PLOT_H;

  const polygons = rows.map((row, k) => {
    const top = cumulative[k];
    const bottom = k === 0 ? null : cumulative[k - 1];
    const forward = top.map((value, i) => `${xAt(i).toFixed(2)},${yAt(value).toFixed(2)}`);
    const back = Array.from({ length: n }, (_, idx) => {
      const i = n - 1 - idx;
      const value = bottom ? bottom[i] : 0;
      return `${xAt(i).toFixed(2)},${yAt(value).toFixed(2)}`;
    });
    return { label: row.label, color: row.color, points: [...forward, ...back].join(" ") };
  });

  const ticks = tickIndices(n);
  const provisional =
    typeof provisionalIndex === "number" &&
    Number.isInteger(provisionalIndex) &&
    provisionalIndex >= 0 &&
    provisionalIndex < n
      ? provisionalIndex
      : null;

  return (
    <div className={className}>
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        // Stated rather than left to the default: uniform scaling is what
        // keeps the dashed provisional rule a rule instead of a stretched
        // wedge, and it is the reason there is no fixed pixel width here.
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full overflow-visible"
      >
        <g aria-hidden="true">
          {/* Ceiling and floor rules. The ceiling is labelled with the real
              peak total rather than a rounded "nice" number: that figure IS
              the population at its largest, which is the caveat the chart
              exists to make visible. */}
          <line
            x1={PAD_LEFT}
            y1={PAD_TOP}
            x2={PAD_LEFT + PLOT_W}
            y2={PAD_TOP}
            className="stroke-border"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <line
            x1={PAD_LEFT}
            y1={baselineY}
            x2={PAD_LEFT + PLOT_W}
            y2={baselineY}
            className="stroke-border"
            strokeWidth={1}
          />
          <text
            x={PAD_LEFT - 8}
            y={PAD_TOP + 4}
            textAnchor="end"
            fontSize={11}
            className="fill-muted-foreground font-mono"
          >
            {max.toLocaleString("en-US")}
          </text>
          <text
            x={PAD_LEFT - 8}
            y={baselineY + 4}
            textAnchor="end"
            fontSize={11}
            className="fill-muted-foreground font-mono"
          >
            0
          </text>

          {/* Keyed by index, here and in the legend, ticks and table below.
              Both `bands` and `xLabels` are strictly POSITIONAL — nothing is
              inserted, removed or reordered between renders, since a
              different series is a different chart re-rendered wholesale —
              so the index is the stable identity. Keying on the caller's
              label would make two bands that happen to share a name (or two
              repeated x labels) collide silently, and this component
              deliberately publishes no uniqueness contract on either prop. */}
          {polygons.map((polygon, k) => (
            <polygon key={k} points={polygon.points} fill={polygon.color} />
          ))}

          {provisional !== null ? (
            <>
              {/* Washed out rather than hatched: a <pattern> needs a document
                  -unique id, and this is a server component with no `useId`,
                  so two instances on one page would collide. Opacity needs no
                  id and degrades safely. The dashed rule and the words carry
                  the meaning for anyone who cannot see the wash. */}
              <rect
                x={xAt(Math.max(provisional - 1, 0))}
                y={PAD_TOP}
                width={xAt(provisional) - xAt(Math.max(provisional - 1, 0))}
                height={PLOT_H}
                className="fill-background"
                fillOpacity={0.55}
              />
              <line
                x1={xAt(provisional)}
                y1={PAD_TOP}
                x2={xAt(provisional)}
                y2={baselineY}
                className="stroke-muted-foreground"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
            </>
          ) : null}

          {ticks.map((i) => (
            <text
              key={i}
              x={xAt(i)}
              y={baselineY + 16}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              fontSize={11}
              className="fill-muted-foreground font-mono"
            >
              {xLabels[i]}
            </text>
          ))}
        </g>
      </svg>

      {/* Visible legend. Bottom band first, matching the stack, so the eye can
          read the list against the picture without reversing it.

          `role="list"` is restated because Tailwind preflight sets
          `list-style: none`, which makes WebKit/VoiceOver drop list semantics
          entirely — the same explicit restatement status-legend.tsx,
          filter-bar.tsx and map-layer-control.tsx carry. ⚠️ jsdom reports the
          list role either way, so no unit test can catch its removal; only an
          assertion on the attribute itself, or a real screen reader, can. */}
      <ul
        role="list"
        aria-label={`${tableCaption} — band key`}
        className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1"
      >
        {rows.map((row, k) => (
          <li key={k} className="flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-[1px] border border-border/40"
              style={{ backgroundColor: row.color }}
            />
            <span className="text-muted-foreground">{row.label}</span>
          </li>
        ))}
      </ul>

      <table className="sr-only">
        {/* `sr-only` sits on the caption AS WELL AS the table, deliberately: a
            `<caption>` box is rendered outside the table's border box, so the
            table's own `position:absolute; clip:rect(0,0,0,0)` does not
            reliably clip it and the caption text can paint as a stray visible
            line above the plot. Hiding it per-element is what
            stacked-band.tsx does (there the table itself is visible). Keep
            both — the table's class is load-bearing for the legend-to-caption
            margin below, so this is not a duplicate to tidy away. */}
        <caption className="sr-only">{tableCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{xHeading}</th>
            {rows.map((row, k) => (
              <th key={k} scope="col">
                {row.label}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {xLabels.map((label, i) => (
            <tr key={i}>
              <th scope="row">
                {provisional === i && provisionalNote
                  ? `${label} (${provisionalNote})`
                  : label}
              </th>
              {rows.map((row, k) => (
                <td key={k}>{row.values[i].toLocaleString("en-US")}</td>
              ))}
              <td>{totals[i].toLocaleString("en-US")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* mt-8, deliberately not the mt-2 stacked-band.tsx uses for its caption:
          there the caption follows a VISIBLE table, so a tight step reads as
          "attached to the thing above". Here the only element between caption
          and legend is an sr-only table with zero visual height, so the margin
          is the whole gap, and both mt-3 and then mt-5 were reported as reading
          too tight under a wrapping text-sm legend row. The step to 32px is a
          typographic judgement, not a measured value. Do not harmonise the two
          values. `mx-auto` centres the BOX on the container and `text-center`
          centres the text inside that box; `max-w-2xl` on its own leaves the
          box left-aligned in a wider parent, which reads as hanging off the
          chart rather than sitting beneath it. ⚠️ Container-centred is not
          plot-centred: PAD_LEFT (46) exceeds PAD_RIGHT (10), so the plot spans
          x=46→710 and centres at x=378 against the container's x=360. The
          legend and caption therefore sit 18 user units left of the plot's own
          centre — 2.5% of the width, which at a ~1232px render is ~31 CSS px
          (the px figure scales with the container; the 2.5% does not). That is
          an accepted simplification, not an oversight: correcting it would
          mean compensating for the padding asymmetry, which is more than was
          asked for. Do not add that compensation without being asked. */}
      {caption ? (
        <p className="mx-auto mt-8 max-w-2xl text-center font-mono text-[10px] leading-relaxed text-muted-foreground">
          {caption}
        </p>
      ) : null}
    </div>
  );
}
