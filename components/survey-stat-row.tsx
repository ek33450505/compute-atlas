import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SurveyStat {
  /** The figure itself — already formatted (e.g. `formatPower(mw)`, `n.toLocaleString()`). */
  value: ReactNode;
  /** Short uppercase caption beneath the figure. */
  label: ReactNode;
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
            {stat.label}
          </span>
        </div>
      ))}
    </div>
  );
}
