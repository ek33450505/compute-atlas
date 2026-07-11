"use client";

import { Satellite } from "lucide-react";

interface BasemapToggleProps {
  isSatellite: boolean;
  onToggle: () => void;
}

/**
 * Toggle button switching the basemap between the parchment street map and
 * Esri World Imagery satellite. Parchment skin + activation ring matching
 * ViewToggle3D / CompassRose. Active (primary) ring when satellite is on.
 */
export function BasemapToggle({ isSatellite, onToggle }: BasemapToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isSatellite}
      aria-label="Toggle satellite imagery"
      className={[
        "flex h-11 w-11 items-center justify-center",
        "rounded-sm bg-popover border border-border",
        "shadow-[0_1px_4px_rgba(0,0,0,0.12)]",
        "cursor-pointer transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        isSatellite ? "ring-1 ring-primary/50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Satellite
        aria-hidden="true"
        className={["size-4", isSatellite ? "text-primary" : "text-foreground"].join(" ")}
      />
    </button>
  );
}
