import type { ReactNode } from "react";

export interface SurveyStat {
  /** The figure itself — already formatted (e.g. `formatPower(mw)`, `n.toLocaleString()`). */
  value: ReactNode;
  /** Short uppercase caption beneath the figure. */
  label: ReactNode;
}

interface SurveyStatRowProps {
  stats: SurveyStat[];
}

/**
 * The multi-up "survey" figure row that sits under a page masthead.
 *
 * Tile count is whatever `stats` holds — most callers pass 4, `/stats` passes 5
 * and `/learn/[topic]` passes 2-4 depending on topic. Presentational only: no
 * interactive roles.
 */
export function SurveyStatRow({ stats }: SurveyStatRowProps) {
  return (
    <div className="flex flex-wrap gap-8 border-b border-border pb-10">
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
