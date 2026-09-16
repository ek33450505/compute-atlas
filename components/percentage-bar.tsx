import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { BarLabelRow } from "@/components/chart/bar-label-row";
import { BarTrack } from "@/components/chart/bar-track";

export interface PercentageBarProps {
  /**
   * Root wrapper tag. Defaults to `"div"`; pass `"li"` when the caller
   * composes a `<ul>` list (e.g. /power's energy-source and cooling-type
   * breakdowns), so the bar stays a valid list item instead of nesting a
   * `<div>` directly inside a `<ul>`.
   */
  as?: "div" | "li";
  /** Left-hand label (e.g. a facility-type, status, or reception name). */
  label: ReactNode;
  /**
   * Right-hand value text. The caller composes the exact format — e.g.
   * `{count} · {pct.toFixed(0)}%` or `{count} / {total} · {pct.toFixed(0)}%`
   * — rather than the component offering a format mini-language.
   */
  valueLabel: ReactNode;
  /** Bar fill width as a percentage (0-100); rendered as `${pct.toFixed(2)}%`. */
  pct: number;
  /** Fill color. Defaults to the shared primary swatch used by every non-status-tinted bar. */
  color?: string;
  /** Fill opacity. Defaults to 0.7; status-tinted bars pass 1 to render getStatusColor() at full strength. */
  opacity?: number;
  /** Adds a `transition-all` class to the fill — used by the "§ By status" bars, whose color changes via getStatusColor(). */
  transition?: boolean;
}

/**
 * The labeled percentage progress-bar block repeated near-identically across
 * /states/[state], /operators/[operator], /opposition, /power, and /stats
 * (DRY consolidation audit, 2026-09): a label + right-hand value line over a
 * track with a colored fill. Two behavioral variants are covered by props
 * instead of a format mini-language: status-tinted bars pass
 * `color`/`opacity`/`transition`, and non-standard right-side text is
 * composed by the caller via `valueLabel`.
 */
export function PercentageBar({
  as = "div",
  label,
  valueLabel,
  pct,
  color = "var(--primary)",
  opacity = 0.7,
  transition = false,
}: PercentageBarProps) {
  const Wrapper = as;
  return (
    <Wrapper className="space-y-1.5">
      {/* Title row shared with StackedBand (components/chart/bar-label-row.tsx). */}
      <BarLabelRow label={label} valueLabel={valueLabel} />
      {/* Rail shared with StackedBand (components/chart/bar-track.tsx) so the
          two never drift on height/radius/ground color. Output of both shared
          pieces is byte-identical to the inline markup they replace. */}
      <BarTrack>
        <div
          aria-hidden="true"
          className={cn("h-full rounded-full", transition && "transition-all")}
          style={{
            width: `${pct.toFixed(2)}%`,
            backgroundColor: color,
            opacity,
          }}
        />
      </BarTrack>
    </Wrapper>
  );
}
