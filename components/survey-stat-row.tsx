import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  StatFootnotes,
  StatLabel,
  assignFootnoteMarkers,
} from "@/components/stat-footnote";

export interface SurveyStat {
  /** The figure itself — already formatted (e.g. `formatPower(mw)`, `n.toLocaleString()`). */
  value: ReactNode;
  /** Short uppercase caption beneath the figure. */
  label: ReactNode;
  /**
   * Optional qualifier for a figure whose caption cannot carry it. Renders as
   * a footnote under the row, behind a `*` marker on this tile's caption.
   *
   * This exists because `statesStat`'s caption used to grow instead —
   * "States + DC + territories", three terms of uppercase wide-tracked mono
   * stacked under a 4xl number, which swamped the figure and unbalanced the
   * row (Ed, QA, 2026-09-14). A footnote keeps the caption one word while the
   * count stays honest about what it does and does not include.
   */
  note?: string;
}

/**
 * Horizontal/vertical gap pairing per `spacing` variant. Kept as full literal
 * class strings (never `` `gap-${n}` ``) since Tailwind's static scan can't
 * see an interpolated class name and would fail to generate it.
 */
const SPACING_CLASSES = {
  default: "gap-8",
  wide: "gap-x-16 gap-y-8",
} as const;

interface SurveyStatRowProps {
  stats: SurveyStat[];
  /**
   * Horizontal rhythm between tiles. Defaults to `"default"` — today's
   * unchanged `gap-8` — so every existing call site renders identically.
   * `"wide"` widens the horizontal gap (keeping vertical rhythm sane when the
   * row wraps) for rows whose labels are multi-word — e.g. "Gas · planned",
   * "Non-fossil · planned" — which crowd under the default gap.
   */
  spacing?: "default" | "wide";
}

/**
 * The multi-up "survey" figure row that sits under a page masthead.
 *
 * Tile count is whatever `stats` holds — most callers pass 4, `/stats` passes 5
 * and `/learn/[topic]` passes 2-4 depending on topic. Presentational only: no
 * interactive roles.
 */
export function SurveyStatRow({ stats, spacing = "default" }: SurveyStatRowProps) {
  const { markerAt, footnotes } = assignFootnoteMarkers(stats);

  // Base + gap variant + shared trailing classes, in that literal order, so
  // the "default" variant's output stays byte-for-byte the prior literal string.
  return (
    <div
      className={cn(
        "flex flex-wrap",
        SPACING_CLASSES[spacing],
        "border-b border-border pb-10"
      )}
    >
      {stats.map((stat, i) => (
        <div key={i} className="flex flex-col items-center gap-1 text-center">
          <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
            {stat.value}
          </span>
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            <StatLabel label={stat.label} marker={markerAt(i)} />
          </span>
        </div>
      ))}
      {/*
        A full-width flex ITEM, not a sibling wrapping the row: the row's own
        class string is pinned by a regression test precisely so a layout
        change meant for one variant cannot leak into all fourteen call sites,
        and wrapping the row in a new element would have meant repointing that
        guard at a different node. `w-full` makes it wrap onto its own line;
        `-mt-4` pulls back half the row's gap, which is tuned for tiles.
      */}
      <StatFootnotes footnotes={footnotes} className="-mt-4" />
    </div>
  );
}
