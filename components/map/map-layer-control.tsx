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
  showWaterStress: boolean;
  onToggleWaterStress: () => void;
  showGroundwater: boolean;
  onToggleGroundwater: () => void;
  showAquifers: boolean;
  onToggleAquifers: () => void;
}

interface LayerToggleProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: () => void;
  /**
   * Representative map color for this layer, shown as a small swatch before
   * the label. Always paired with the text label — Ed (the maintainer) is
   * color-deficient, so the swatch alone is never the sole cue; it's a quick
   * visual key for what's already on the map, not the source of truth.
   */
  swatchColor: string;
}

/** A single labeled checkbox row with a ≥44px hit target, a color swatch, and a visible focus ring. */
function LayerToggle({ id, label, checked, onChange, swatchColor }: LayerToggleProps) {
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
        <span
          aria-hidden="true"
          className="size-3 shrink-0 rounded-[1px] border border-border/40"
          style={{ backgroundColor: swatchColor }}
        />
        {label}
      </label>
    </li>
  );
}

interface LayerGroupProps {
  title: string;
  children: React.ReactNode;
}

/** A named group of layer toggles (e.g. "Water", "Power", "Geology"). */
function LayerGroup({ title, children }: LayerGroupProps) {
  return (
    <div>
      <p className="mb-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/80">
        {title}
      </p>
      <ul role="list" className="space-y-0.5">
        {children}
      </ul>
    </div>
  );
}

/**
 * Compact progressive-disclosure control for the map's optional data overlays,
 * grouped by theme (Water / Power / Geology). Collapsed by default (on every
 * viewport) into an icon-only button — sized/styled to match its sibling
 * icon buttons in the Tools column (CompassRose / ViewToggle3D /
 * BasemapToggle / the radius toggle: h-11 w-11, parchment skin, primary
 * ring when active); expands into a small panel with grouped checkbox
 * toggles (each with a color swatch keying its map color) plus a per-layer
 * attribution/"as of" caption.
 *
 * Styling mirrors MapLegend / BasemapToggle (parchment bg-popover +
 * border-border, ≥44px hit targets, focus-visible rings).
 *
 * Alignment: the root is its own `flex flex-col items-end` — not just a
 * plain block wrapper — so the button and the (much wider) expanded panel
 * each right-align independently to the control's own box. Without this,
 * a plain block wrapper's width is dictated by its widest child (the
 * panel, once mounted), and the fixed-width button — a block element with
 * no auto margins — stays glued to the wrapper's LEFT edge while the
 * panel is right-aligned by the parent Tools column's own `items-end`,
 * so the two visibly diverge. `items-end` here keeps the button pinned to
 * the same page position whether the panel is open or closed, and the
 * panel opens downward (`mt-2`, later in flex-col order) with its right
 * edge matching the button's — i.e. it grows to the left.
 */
export function MapLayerControl({
  showWater,
  onToggleWater,
  showPower,
  onTogglePower,
  showDrought,
  onToggleDrought,
  showWaterStress,
  onToggleWaterStress,
  showGroundwater,
  onToggleGroundwater,
  showAquifers,
  onToggleAquifers,
}: MapLayerControlProps) {
  const [expanded, setExpanded] = useState(false);
  const anyOn =
    showWater ||
    showPower ||
    showDrought ||
    showWaterStress ||
    showGroundwater ||
    showAquifers;

  return (
    <div className="pointer-events-auto flex flex-col items-end">
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

            <div className="space-y-3">
              <LayerGroup title="Water">
                <LayerToggle
                  id="map-layer-water"
                  label="Waterways"
                  checked={showWater}
                  onChange={onToggleWater}
                  swatchColor="#5E7D8A"
                />
                <LayerToggle
                  id="map-layer-water-stress"
                  label="Baseline water stress"
                  checked={showWaterStress}
                  onChange={onToggleWaterStress}
                  swatchColor="#7CA9C0"
                />
                <LayerToggle
                  id="map-layer-groundwater"
                  label="Groundwater decline"
                  checked={showGroundwater}
                  onChange={onToggleGroundwater}
                  swatchColor="#A87FC0"
                />
                <LayerToggle
                  id="map-layer-drought"
                  label="Drought"
                  checked={showDrought}
                  onChange={onToggleDrought}
                  swatchColor="#D69C5A"
                />
              </LayerGroup>

              <LayerGroup title="Power">
                <LayerToggle
                  id="map-layer-power"
                  label="Transmission (≥230 kV)"
                  checked={showPower}
                  onChange={onTogglePower}
                  swatchColor="#8F4108"
                />
              </LayerGroup>

              <LayerGroup title="Geology">
                <LayerToggle
                  id="map-layer-aquifers"
                  label="Aquifers"
                  checked={showAquifers}
                  onChange={onToggleAquifers}
                  swatchColor="#C9B79C"
                />
              </LayerGroup>
            </div>

            {anyOn && (
              <p className="mt-2 space-y-0.5 border-t border-border/60 pt-1.5 font-mono text-[9px] leading-tight text-muted-foreground">
                {showWater && <span className="block">Water: {mapLayers.water.attribution}</span>}
                {showWaterStress && (
                  <span className="block">
                    Water stress: {mapLayers.waterStress.attribution}
                  </span>
                )}
                {showGroundwater && (
                  <span className="block">
                    Groundwater: {mapLayers.groundwaterDecline.attribution}
                  </span>
                )}
                {showDrought && (
                  <span className="block">
                    Drought as of {mapLayers.drought.asOf} &mdash; {mapLayers.drought.attribution}
                  </span>
                )}
                {showPower && <span className="block">Power: {mapLayers.power.attribution}</span>}
                {showAquifers && (
                  <span className="block">Aquifers: {mapLayers.aquifers.attribution}</span>
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
