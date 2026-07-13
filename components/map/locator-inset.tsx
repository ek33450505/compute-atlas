"use client";

import { useEffect, useMemo, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { computeLocatorFrame, projectToFrame } from "@/lib/map";
import type { Facility } from "@/lib/schema";

interface LocatorInsetProps {
  facilities: Facility[];
  map: MapLibreMap | null;
}

interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Engraved "locator inset" overlay — a small overview map plotting the full
 * facility footprint as faint ink dots (their scatter traces the US, so no
 * fabricated coastline is drawn), with a live "you are here" ink rectangle
 * marking the main map's current viewport.
 *
 * Design decisions:
 * - Styling mirrors the "Key to Symbols" print-key idiom in map-legend.tsx:
 *   opaque parchment double-neatline panel.
 * - The viewport rectangle is distinguished by LUMINANCE (a solid dark
 *   hairline stroke), not hue — the project is calibrated for a
 *   color-deficient viewer, so color alone is never load-bearing.
 * - This component owns the rect state locally and subscribes directly to
 *   the maplibre "move" event, so the parent FacilityMap does not re-render
 *   on every pan/zoom frame.
 * - aria-hidden: purely a visual orientation aid, same rationale as the
 *   pointer coordinate readout in facility-map.tsx — screen reader users
 *   navigate markers, not a viewport indicator.
 */
export function LocatorInset({ facilities, map }: LocatorInsetProps) {
  const frame = useMemo(() => computeLocatorFrame(facilities), [facilities]);

  const dots = useMemo(() => {
    if (!frame) return [];
    return facilities.map((f) =>
      projectToFrame(f.location.lon, f.location.lat, frame)
    );
  }, [facilities, frame]);

  const [rect, setRect] = useState<ViewportRect | null>(null);

  useEffect(() => {
    if (!map || !frame) return;

    const update = () => {
      const b = map.getBounds();
      const nw = projectToFrame(b.getWest(), b.getNorth(), frame);
      const se = projectToFrame(b.getEast(), b.getSouth(), frame);

      const x0 = Math.max(0, Math.min(nw.x, se.x));
      const y0 = Math.max(0, Math.min(nw.y, se.y));
      const x1 = Math.min(frame.width, Math.max(nw.x, se.x));
      const y1 = Math.min(frame.height, Math.max(nw.y, se.y));

      setRect({ x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) });
    };

    update();
    map.on("move", update);
    return () => {
      map.off("move", update);
    };
  }, [map, frame]);

  if (!frame) return null;

  return (
    <div
      aria-hidden="true"
      data-locator-inset
      className="absolute top-16 left-3 z-10 hidden select-none rounded-sm border border-border bg-popover p-[3px] pointer-events-none sm:block"
    >
      <div className="rounded-[1px] border border-border/50 p-1">
        <svg
          role="presentation"
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          width={frame.width}
          height={frame.height}
          className="block"
        >
          {dots.map((d, i) => (
            <circle
              key={i}
              cx={d.x}
              cy={d.y}
              r="0.7"
              className="fill-muted-foreground/40"
            />
          ))}
          {rect && (
            <rect
              x={rect.x}
              y={rect.y}
              width={rect.w}
              height={rect.h}
              rx="1"
              className="fill-foreground/5 stroke-foreground"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
    </div>
  );
}
