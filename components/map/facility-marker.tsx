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
 * - Minimum 24×24 px tap area; visible :focus-visible ring
 * - Hover scale animation is suppressed via `motion-safe:` variant
 *
 * TODO(M3+): clustering when dataset grows
 */
export const FacilityMarker = forwardRef<HTMLButtonElement, FacilityMarkerProps>(
  ({ facility, isSelected, onSelect }, ref) => {
    const meta = getStatusMeta(facility.status);
    const Icon = meta.icon;

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
          "min-w-[28px] min-h-[28px] p-1",
          "rounded-full border shadow-sm",
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
