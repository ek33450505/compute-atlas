import { cn } from "@/lib/utils";

interface GraticuleSurveyProps {
  className?: string;
}

/**
 * Self-surveyed graticule — the hero's hairline lat/long grid draws itself in
 * on load, as if being plotted, then settles into the exact static grid.
 *
 * Server component: the effect is pure CSS (mask-image wipe + keyframes in
 * globals.css), so there is no client JS and no hydration cost. The verticals
 * wipe left-to-right, then the horizontals wipe top-to-bottom shortly after,
 * reading as the grid being surveyed rather than faded in.
 *
 * Respects prefers-reduced-motion: the default (unanimated) state of each
 * layer is the fully-revealed grid, so reduced-motion users — and the
 * settled post-animation state for everyone else — see the complete grid
 * with no flash.
 */
export function GraticuleSurvey({ className }: GraticuleSurveyProps) {
  return (
    <div aria-hidden="true" className={cn("graticule-survey", className)}>
      <div className="grat-axis-x" />
      <div className="grat-axis-y" />
    </div>
  );
}
