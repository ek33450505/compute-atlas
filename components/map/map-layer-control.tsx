"use client";

import { useState, useSyncExternalStore } from "react";
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

function subscribeWideViewport(onChange: () => void) {
  const mql = window.matchMedia("(min-width: 640px)");
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getWideViewportSnapshot() {
  return window.matchMedia("(min-width: 640px)").matches;
}

function getWideViewportServerSnapshot() {
  return true;
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
 * viewport) into a small "Layers" button; expands into a small panel with
 * three checkbox toggles plus a per-layer attribution/"as of" caption.
 *
 * Styling mirrors MapLegend / BasemapToggle (parchment bg-popover + border-border,
 * ≥44px hit targets, focus-visible rings). The isWide check (mirrors
 * MapFilterSubheader's useSyncExternalStore + matchMedia pattern) only trims the
 * collapsed button's text label on narrow viewports so it doesn't crowd the
 * floating control column on phones — the button itself always starts collapsed.
 */
export function MapLayerControl({
  showWater,
  onToggleWater,
  showPower,
  onTogglePower,
  showDrought,
  onToggleDrought,
}: MapLayerControlProps) {
  const isWide = useSyncExternalStore(
    subscribeWideViewport,
    getWideViewportSnapshot,
    getWideViewportServerSnapshot
  );
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
        className={[
          "flex h-11 items-center gap-1.5 rounded-sm border border-border bg-popover px-3",
          "font-mono text-[10px] uppercase tracking-widest text-foreground",
          "shadow-[0_1px_4px_rgba(0,0,0,0.12)] cursor-pointer transition-colors",
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
        {isWide && <span className="whitespace-nowrap">Layers</span>}
        <span
          className={`inline-flex transition-transform duration-150 ease-in-out motion-reduce:transition-none ${
            expanded ? "rotate-180" : "rotate-0"
          }`}
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16" width="10" height="10">
            <polyline
              points="3,5 8,11 13,5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
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
