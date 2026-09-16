import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The `role`/name pair, as a discriminated union rather than two independent
 * optionals. `role="img"` with no accessible name is announced as an
 * unlabelled graphic — worse than no role at all — so the two cannot be
 * separated: naming the track is only meaningful when it IS the graphic, and
 * declaring it the graphic is only safe once it is named.
 */
type BarTrackLabelling =
  | {
      /**
       * `"img"` when the track IS the graphic (StackedBand, whose segments
       * carry the data). Requires `ariaLabel`.
       */
      role: "img";
      /** Accessible name for the graphic. */
      ariaLabel: string;
    }
  | {
      /**
       * Omitted when the track is only the ground under a single fill whose
       * value is already stated in adjacent text (PercentageBar). An unroled
       * track takes no name — a bare `aria-label` on a generic `<div>` is
       * ignored by assistive tech anyway.
       */
      role?: never;
      ariaLabel?: never;
    };

export type BarTrackProps = {
  /** The fill(s) painted inside the rail. Always decorative — mark them `aria-hidden`. */
  children: ReactNode;
  className?: string;
} & BarTrackLabelling;

/**
 * The rounded, clipped, muted rail shared by `PercentageBar` (one partial
 * fill) and `StackedBand` (n fills partitioning the whole width).
 *
 * Extracted rather than copied for the same reason `lib/map-overlays.ts`
 * centralizes the ramps: two bars sitting on the same page must not drift on
 * height, radius or ground color. `cn()` is tailwind-merge, so a caller
 * passing `h-2.5` replaces the default `h-1.5` instead of fighting it.
 */
export function BarTrack({ children, role, ariaLabel, className }: BarTrackProps) {
  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      {children}
    </div>
  );
}
