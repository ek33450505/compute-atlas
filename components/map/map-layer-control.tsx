"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Layers } from "lucide-react";

import mapLayers from "@/public/data/map-layers.json";
import {
  DROUGHT_KEY_LABELS,
  DROUGHT_RAMP,
  FILL_ONLY_OVERLAY_IDS,
  colorForGroundwaterLabel,
  colorForWaterStressLabel,
  orderedGroundwaterDistribution,
  orderedWaterStressDistribution,
} from "@/lib/map-overlays";

const PANEL_ID = "map-layer-control-panel";
const SATELLITE_HINT = "shown on standard basemap only";

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
  /**
   * True when the map's active basemap is the satellite raster. Water
   * stress / groundwater decline / drought render as pure fills with no
   * visible edge, so they're invisible over imagery — this disables (but
   * does not auto-toggle-off) their controls and shows an inline hint.
   */
  isSatellite: boolean;
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
  disabled?: boolean;
  hint?: string;
}

/**
 * A single labeled checkbox row with a ≥44px hit target, a color swatch, and
 * a visible focus ring. When disabled with a hint, the hint renders as a
 * sibling caption wired via `aria-describedby` (not nested inside the
 * `<label>`) so it's announced to screen readers alongside the control
 * without becoming part of the label's accessible NAME — keeping
 * `getByLabelText("Baseline water stress")`-style exact-name lookups
 * (both in tests and assistive tech) working regardless of disabled state.
 */
function LayerToggle({ id, label, checked, onChange, swatchColor, disabled, hint }: LayerToggleProps) {
  const hintId = `${id}-hint`;
  const showHint = Boolean(disabled && hint);
  return (
    <li>
      <label
        htmlFor={id}
        className={[
          "flex min-h-11 items-center gap-2 rounded-sm px-1 text-xs text-foreground",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-muted",
        ].join(" ")}
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          aria-describedby={showHint ? hintId : undefined}
          className="size-4 shrink-0 accent-primary rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed"
        />
        <span
          aria-hidden="true"
          className="size-3 shrink-0 rounded-[1px] border border-border/40"
          style={{ backgroundColor: swatchColor }}
        />
        {label}
      </label>
      {showHint && (
        <p
          id={hintId}
          className="-mt-0.5 pb-0.5 pl-7 font-mono text-[9px] italic leading-tight text-muted-foreground/80"
        >
          {hint}
        </p>
      )}
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

interface DistributionLegendProps {
  title: string;
  entries: Array<{ label: string; count: number }>;
  colorFor: (label: string) => string | undefined;
}

/**
 * Compact legend for a distribution-backed overlay: one row per severity
 * band, swatch + label + right-aligned facility count (tabular-nums so
 * counts align). Ordered most-severe-first by the caller.
 */
function DistributionLegend({ title, entries, colorFor }: DistributionLegendProps) {
  return (
    <div className="mt-1 rounded-sm border border-border/40 bg-background/40 px-2 py-1.5">
      <p className="mb-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
        {title}
      </p>
      <ul role="list" className="space-y-0.5">
        {entries.map(({ label, count }) => (
          <li key={label} className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-[1px] border border-border/40"
              style={{ backgroundColor: colorFor(label) ?? "transparent" }}
            />
            <span className="flex-1 truncate">{label}</span>
            <span className="tabular-nums text-foreground/80">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Key-only legend (no per-facility counts) for the drought ramp. */
function DroughtKeyLegend() {
  return (
    <div className="mt-1 rounded-sm border border-border/40 bg-background/40 px-2 py-1.5">
      <p className="mb-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
        Drought
      </p>
      <ul role="list" className="space-y-0.5">
        {DROUGHT_KEY_LABELS.map((label, i) => (
          <li key={label} className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-[1px] border border-border/40"
              style={{ backgroundColor: DROUGHT_RAMP[DROUGHT_RAMP.length - 1 - i] }}
            />
            <span className="flex-1 truncate">{label}</span>
          </li>
        ))}
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
 * attribution/"as of" caption and, for the distribution-backed overlays, a
 * compact ordinal legend.
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
 *
 * The panel's inner content is its own scroll container
 * (`overflow-y-auto`, with a static `max-h-[calc(100dvh-8rem)]` fallback
 * class for first paint). Because the button lives low in a stacked Tools
 * column, its top offset varies a lot — a purely viewport-relative cap is
 * often taller than the actual space left below the panel, which leaves
 * content overflowing the viewport with no scrollbar. A `useLayoutEffect`
 * measures the container's real top via `getBoundingClientRect()` on
 * expand/resize and applies an inline `maxHeight` (viewport height minus
 * top offset minus a small margin) that overrides the static class, so the
 * panel scrolls internally and never exceeds the viewport bottom.
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
  isSatellite,
}: MapLayerControlProps) {
  const [expanded, setExpanded] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollMaxHeight, setScrollMaxHeight] = useState<number | undefined>(undefined);
  const anyOn =
    showWater ||
    showPower ||
    showDrought ||
    showWaterStress ||
    showGroundwater ||
    showAquifers;

  const fillOnlyDisabled = isSatellite;

  useEffect(() => {
    if (!expanded) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setExpanded(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [expanded]);

  // The panel can open low in the viewport (it's the last of several
  // stacked tool buttons), so a static viewport-relative max-height
  // (e.g. `100dvh - 8rem`) is frequently taller than the space actually
  // remaining below the panel — content then overflows the viewport
  // bottom with no scrollbar, because it's shorter than the (too-generous)
  // static cap. Measure the panel's real top offset instead and cap the
  // scroll container to exactly what's left above the viewport bottom.
  useLayoutEffect(() => {
    if (!expanded) {
      setScrollMaxHeight(undefined);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;

    function recompute() {
      const node = scrollRef.current;
      if (!node) return;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const top = node.getBoundingClientRect().top;
      setScrollMaxHeight(Math.max(120, viewportHeight - top - 16));
    }

    recompute();
    window.addEventListener("resize", recompute);
    window.visualViewport?.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("resize", recompute);
      window.visualViewport?.removeEventListener("resize", recompute);
    };
  }, [expanded]);

  const waterStressDisabled = fillOnlyDisabled && FILL_ONLY_OVERLAY_IDS.includes("waterStress");
  const groundwaterDisabled = fillOnlyDisabled && FILL_ONLY_OVERLAY_IDS.includes("groundwater");
  const droughtDisabled = fillOnlyDisabled && FILL_ONLY_OVERLAY_IDS.includes("drought");

  return (
    <div className="pointer-events-auto flex flex-col items-end">
      <button
        ref={buttonRef}
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
          "cursor-pointer transition-colors motion-reduce:transition-none",
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
          <div
            ref={scrollRef}
            style={scrollMaxHeight !== undefined ? { maxHeight: `${scrollMaxHeight}px` } : undefined}
            className="max-h-[calc(100dvh-8rem)] min-w-[190px] overflow-y-auto overscroll-contain rounded-[1px] border border-border/50 px-3 py-2.5"
          >
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
                  disabled={waterStressDisabled}
                  hint={SATELLITE_HINT}
                />
                {showWaterStress && (
                  <DistributionLegend
                    title="Baseline water stress"
                    entries={orderedWaterStressDistribution(mapLayers.waterStress.distribution)}
                    colorFor={colorForWaterStressLabel}
                  />
                )}
                <LayerToggle
                  id="map-layer-groundwater"
                  label="Groundwater decline"
                  checked={showGroundwater}
                  onChange={onToggleGroundwater}
                  swatchColor="#A87FC0"
                  disabled={groundwaterDisabled}
                  hint={SATELLITE_HINT}
                />
                {showGroundwater && (
                  <DistributionLegend
                    title="Groundwater decline"
                    entries={orderedGroundwaterDistribution(mapLayers.groundwaterDecline.distribution)}
                    colorFor={colorForGroundwaterLabel}
                  />
                )}
                <LayerToggle
                  id="map-layer-drought"
                  label="Drought"
                  checked={showDrought}
                  onChange={onToggleDrought}
                  swatchColor="#D69C5A"
                  disabled={droughtDisabled}
                  hint={SATELLITE_HINT}
                />
                {showDrought && <DroughtKeyLegend />}
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
