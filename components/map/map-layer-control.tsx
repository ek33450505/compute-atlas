"use client";

import { useState } from "react";
import { Layers } from "lucide-react";

import mapLayers from "@/public/data/map-layers.json";

const PANEL_ID = "map-layer-control-panel";

export interface MapLayerControlProps {
  showWater: boolean;
  onToggleWater: () => void;
  showPower: boolean;
  onTogglePower: () => void;
  showDrought: boolean;
  onToggleDrought: () => void;
}

interface LayerToggleProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: () => void;
}

/** A single labeled checkbox row with a ≥44px hit target and a visible focus ring. */
function LayerToggle({ id, label, checked, onChange }: LayerToggleProps) {
  return (
    <li>
      <label
        htmlFor={id}
        className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-1 text-xs text-foreground hover:bg-muted"
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={onChange}
          className="size-4 shrink-0 accent-primary rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        />
        {label}
      </label>
    </li>
  );
}

/**
 * Compact progressive-disclosure control for the map's optional data overlays
 * (waterways, transmission lines, drought). Collapsed by default (on every
 * viewport) into an icon-only button — sized/styled to match its sibling
 * icon buttons in the Tools column (CompassRose / ViewToggle3D /
 * BasemapToggle / the radius toggle: h-11 w-11, parchment skin, primary
 * ring when active); expands into a small panel with three checkbox
 * toggles plus a per-layer attribution/"as of" caption.
 *
 * Styling mirrors MapLegend / BasemapToggle (parchment bg-popover +
 * border-border, ≥44px hit targets, focus-visible rings).
 */
export function MapLayerControl({
  showWater,
  onToggleWater,
  showPower,
  onTogglePower,
  showDrought,
  onToggleDrought,
}: MapLayerControlProps) {
  const [expanded, setExpanded] = useState(false);
  const anyOn = showWater || showPower || showDrought;

  return (
    <div className="pointer-events-auto">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls={PANEL_ID}
        aria-label={expanded ? "Hide map layers panel" : "Show map layers panel"}
        title="Map layers"
        className={[
          "flex h-11 w-11 items-center justify-center",
          "rounded-sm bg-popover border border-border",
          "shadow-[0_1px_4px_rgba(0,0,0,0.12)]",
          "cursor-pointer transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          anyOn ? "ring-1 ring-primary/50" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <Layers
          aria-hidden="true"
          className={["size-4", anyOn ? "text-primary" : "text-foreground"].join(" ")}
        />
      </button>

      {expanded && (
        <div
          id={PANEL_ID}
          className="mt-2 rounded-sm border border-border bg-popover p-[3px]"
        >
          <div className="min-w-[190px] rounded-[1px] border border-border/50 px-3 py-2.5">
            <p className="mb-2 border-b border-border/60 pb-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Optional layers
            </p>
            <ul role="list" className="space-y-0.5">
              <LayerToggle
                id="map-layer-water"
                label="Waterways"
                checked={showWater}
                onChange={onToggleWater}
              />
              <LayerToggle
                id="map-layer-power"
                label="Transmission (≥230 kV)"
                checked={showPower}
                onChange={onTogglePower}
              />
              <LayerToggle
                id="map-layer-drought"
                label="Drought"
                checked={showDrought}
                onChange={onToggleDrought}
              />
            </ul>
            {anyOn && (
              <p className="mt-2 space-y-0.5 border-t border-border/60 pt-1.5 font-mono text-[9px] leading-tight text-muted-foreground">
                {showWater && <span className="block">Water: {mapLayers.water.attribution}</span>}
                {showPower && <span className="block">Power: {mapLayers.power.attribution}</span>}
                {showDrought && (
                  <span className="block">
                    Drought as of {mapLayers.drought.asOf} &mdash; {mapLayers.drought.attribution}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
