"use client";

import { forwardRef } from "react";

interface ClusterMarkerProps {
  count: number;
  label: string;
  onSelect: () => void;
}

/** Returns a size class string based on member count (px diameter). */
function sizeClass(count: number): string {
  if (count >= 100) return "w-9 h-9"; // 36px
  if (count >= 10) return "w-8 h-8";  // 32px
  return "w-7 h-7";                   // 28px
}

/**
 * Accessible cluster bubble rendered inside a react-map-gl <Marker>.
 *
 * Accessibility contract:
 * - Real <button> element: keyboard-focusable, screen-reader-discoverable
 * - aria-label describes the cluster (injected by parent, e.g. "Cluster of N datacenters — activate to zoom in")
 * - Round, high-contrast neutral style visually distinct from status-colored singleton markers
 * - Fixed min 28×28 px target meets WCAG 2.2 SC 2.5.8 (≥24×24 px); visible :focus-visible ring
 * - Hover scale animation is suppressed via `motion-safe:` variant (respects prefers-reduced-motion)
 */
export const ClusterMarker = forwardRef<HTMLButtonElement, ClusterMarkerProps>(
  ({ count, label, onSelect }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        onClick={onSelect}
        className={[
          "flex items-center justify-center",
          sizeClass(count),
          "rounded-full border border-foreground/30 shadow-md",
          "bg-foreground/90 text-background",
          "text-xs font-semibold leading-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          "motion-safe:hover:scale-110 motion-safe:transition-transform",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {count}
      </button>
    );
  }
);
ClusterMarker.displayName = "ClusterMarker";
