import type { ReactNode } from "react";

export interface BarLabelRowProps {
  /** Left column: what the bar is about (a band name, a facility type, a status). */
  label: ReactNode;
  /**
   * Right column: the figure. The caller composes the exact format — e.g.
   * `{count} · {pct.toFixed(0)}%` or `1,914 sites · map snapshot` — rather
   * than this row offering a format mini-language.
   *
   * Typed as required because the column always exists, but `ReactNode`
   * admits `undefined`: an omitted value renders an empty span, not a
   * collapsed column. That is deliberate — it is what `PercentageBar` has
   * always emitted, and under `justify-between` an empty trailing span is
   * inert, so the two callers share one markup path with no flag.
   */
  valueLabel: ReactNode;
}

/**
 * The two-column baseline title line above a bar: name at the left, figure
 * right-aligned in tabular mono so stacked bars' digits line up.
 *
 * Extracted for the same reason as its sibling `BarTrack` — `PercentageBar`
 * and `StackedBand` render on the same pages, so their title rows must not
 * drift on alignment, gap or type scale. This is the one piece of markup the
 * BarTrack refactor left copied between them.
 *
 * Output is byte-identical to the inline markup it replaces in
 * `PercentageBar` (verified against a captured golden for all six call-site
 * prop shapes plus an `undefined` and an empty `valueLabel`).
 */
export function BarLabelRow({ label, valueLabel }: BarLabelRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-foreground">{label}</span>
      <span className="font-mono tabular-nums text-muted-foreground">
        {valueLabel}
      </span>
    </div>
  );
}
