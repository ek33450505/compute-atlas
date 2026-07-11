"use client";

import { forwardRef } from "react";
import { getStatusMeta, getStatusColor } from "@/lib/status";
import { buildMarkerLabel } from "@/lib/map";
import type { Facility } from "@/lib/schema";

interface FacilityMarkerProps {
  facility: Facility;
  isSelected: boolean;
  onSelect: (facility: Facility) => void;
}

/**
 * Accessible marker button rendered inside a react-map-gl <Marker>.
 *
 * Accessibility contract:
 * - Real <button> element: keyboard-focusable, screen-reader-discoverable
 * - aria-label describes the facility (name, operator, location, status, capacity)
 * - aria-pressed conveys selected state
 * - Icon is aria-hidden (status is communicated by both shape AND color)
 * - Fixed 28×28 px target meets WCAG 2.2 SC 2.5.8 (≥24×24 px); visible :focus-visible ring
 * - Hover scale animation is suppressed via `motion-safe:` variant
 * - facilityType is also communicated by shape: circle for data_center,
 *   rounded-square for crypto_mining, sharp square for power_generation —
 *   a pure border-radius swap, not a rotation, so the child status icon
 *   stays upright
 *
 * Only rendered for singleton (unclustered) points — see
 * components/map/facility-map.tsx for the cluster/singleton branch and
 * components/map/cluster-marker.tsx for the count-only cluster bubble.
 */
export const FacilityMarker = forwardRef<HTMLButtonElement, FacilityMarkerProps>(
  ({ facility, isSelected, onSelect }, ref) => {
    const meta = getStatusMeta(facility.status);
    const Icon = meta.icon;
    const shapeClassName =
      facility.facilityType === "crypto_mining"
        ? "rounded-md"
        : facility.facilityType === "power_generation"
          ? "rounded-none"
          : "rounded-full";

    return (
      <button
        ref={ref}
        type="button"
        aria-label={buildMarkerLabel(facility)}
        aria-pressed={isSelected}
        onClick={() => onSelect(facility)}
        style={{ color: getStatusColor(facility.status) }}
        className={[
          "flex items-center justify-center",
          "w-[28px] h-[28px]",
          shapeClassName,
          "border shadow-sm",
          "bg-background/90",
          isSelected ? "border-current ring-2 ring-current/30" : "border-current/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          "motion-safe:hover:scale-110 motion-safe:transition-transform",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <Icon aria-hidden="true" className="size-4" />
      </button>
    );
  }
);
FacilityMarker.displayName = "FacilityMarker";
