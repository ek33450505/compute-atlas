"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Droplets, ExternalLink, X, Zap } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import {
  formatNearestTransmission,
  formatNearestWater,
  getSitingContext,
} from "@/lib/siting-context";
import type { Facility } from "@/lib/schema";

interface FacilityPopupProps {
  facility: Facility;
  onClose: () => void;
}

/**
 * Content rendered inside a react-map-gl <Popup> when a marker is selected.
 *
 * Accessibility contract:
 * - Focus moves to the close button on mount
 * - Escape key closes the popup (keydown listener scoped to document, cleaned up on unmount)
 * - External source link includes "opens in new tab" in its aria-label
 * - "View details →" link target (/facilities/:id) is M4; the link is safe to include now
 * - Close button returns focus to the triggering marker (managed by FacilityMap parent)
 */
export function FacilityPopup({ facility, onClose }: FacilityPopupProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Move focus to the close button when the popup opens
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [onClose]);

  const bodyRef = useRef<HTMLDivElement>(null);
  // Measured cap for the popup's own scrollable body (everything below the
  // header), mirroring FacilityMap's Tools panel measurement pattern
  // (components/map/facility-map.tsx, toolsPanelMaxHeight effect). MapLibre
  // dynamically re-anchors this popup (top/bottom/left/right/corners — see
  // the <Popup> comment in facility-map.tsx) so its distance to the bottom
  // of the map varies a lot with viewport height; on landscape phones the
  // card's natural height exceeded the space left below it, clipping the
  // footer (location, siting context, source link, "View details") with no
  // way to reach it — the map's ancestor is overflow-hidden. The header
  // (name + Close) stays OUTSIDE this measurement/scroll region on purpose:
  // Close must stay reachable and visible no matter how tall the rest gets.
  // Bounded against the nearest .maplibregl-map ancestor's own bottom edge,
  // not just the window — that's the real clipping boundary, since the
  // popup is painted inside that overflow-hidden container (confirmed:
  // maplibre-gl adds the "maplibregl-map" class directly to the element it
  // renders into, and appends popups as children of that same element).
  // Falls back to the viewport when that ancestor can't be found (e.g. in
  // isolated component tests, which don't mount inside a real map).
  //
  // react-map-gl's own <Popup> wrapper (@vis.gl/react-maplibre) renders
  // children into a detached `document.createElement('div')` via
  // createPortal, and only attaches that node to the live map — via
  // `popup.setDOMContent(container).addTo(map)` — inside ITS OWN plain
  // useEffect. Child effects (this one) always commit before a parent's,
  // portal or not, so on every popup open this effect's first run sees a
  // still-DETACHED bodyRef: getBoundingClientRect() on a disconnected node
  // reports an all-zero rect, which produced a bogus, always-oversized cap
  // that never actually constrained anything (measured: identical 248px
  // card height on every viewport, including ones far too short to fit
  // it — the "fix" was a no-op). Retry on the next animation frame until
  // node.isConnected is true, i.e. until react-map-gl has actually attached
  // and MapLibre has positioned it.
  const [bodyMaxHeight, setBodyMaxHeight] = useState<number | undefined>(
    undefined
  );
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    let frame: number | undefined;

    function recompute() {
      const node = bodyRef.current;
      if (!node) return;
      if (!node.isConnected) {
        frame = requestAnimationFrame(recompute);
        return;
      }
      const mapContainer = node.closest(".maplibregl-map");
      const bottomBound = mapContainer
        ? mapContainer.getBoundingClientRect().bottom
        : (window.visualViewport?.height ?? window.innerHeight);
      const top = node.getBoundingClientRect().top;
      // 20px reserves the chrome that trails AFTER this body div and before
      // the map's true edge, none of which is part of bodyRef itself: the
      // outer card's own p-1 bottom padding (4px) + .atlas-popup
      // .maplibregl-popup-content's bottom padding (0.7rem = 11.2px,
      // app/globals.css) + its 1px border, plus a couple px of safety
      // margin. Measured without this: a consistent ~8px residual clip on
      // every cramped viewport tested (320×568, 667×375, 844×390).
      setBodyMaxHeight(Math.max(0, bottomBound - top - 20));
    }

    recompute();
    window.addEventListener("resize", recompute);
    window.visualViewport?.addEventListener("resize", recompute);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener("resize", recompute);
      window.visualViewport?.removeEventListener("resize", recompute);
    };
  }, [facility.id]);

  const { location, capacityMw, sources, confidence } = facility;
  const firstSource = sources[0];
  const cityState = location.city
    ? `${location.city}, ${location.state}`
    : location.state;
  const sitingContext = getSitingContext(facility.id);
  const { nearestWater, nearestTransmission } = sitingContext ?? {};

  return (
    <div className="p-1 min-w-[220px] max-w-[min(280px,calc(100vw-5rem))]">
      {/* Header — deliberately kept OUTSIDE the scrollable body below, so
          Close stays visible and reachable no matter how tall the rest of
          the card gets. */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold leading-tight">{facility.name}</h3>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Scrollable body: everything below the header. max-h-[60vh] is the
          pre-measurement CSS fallback; the inline style overrides it once
          bodyMaxHeight is measured (see the effect above) against the real
          space left inside the map before its own bottom edge. */}
      <div
        ref={bodyRef}
        style={
          bodyMaxHeight !== undefined ? { maxHeight: `${bodyMaxHeight}px` } : undefined
        }
        className="max-h-[60vh] overflow-y-auto overscroll-contain"
      >
        {/* Operator */}
        <p className="text-xs text-foreground mb-2">{facility.operator}</p>

        {/* Status badge */}
        <div className="mb-2">
          <StatusBadge status={facility.status} />
        </div>

        {/* Location */}
        <p className="text-xs text-foreground mb-1">{cityState}</p>
        {location.precision === "representative_multi_site" && (
          <p className="text-xs italic text-muted-foreground mb-1">
            Distributed operation — pin is illustrative
            {facility.location.multiSite && ` (${facility.location.multiSite.states.join(", ")})`}
          </p>
        )}

        {/* Siting cue: pure proximity, not a stated interconnection — compact
            one-line summary of the on-page SitingContextSection. Nothing renders
            when neither datum is present. */}
        {(nearestWater || nearestTransmission) && (
          <p className="flex items-center gap-2 mb-2 font-mono text-[10px]/tight tabular-nums text-muted-foreground">
            {nearestWater && (
              <span className="flex items-center gap-1">
                <Droplets className="size-3" aria-hidden="true" />
                {formatNearestWater(nearestWater.name, nearestWater.distanceMi)}
              </span>
            )}
            {nearestTransmission && (
              <span className="flex items-center gap-1">
                <Zap className="size-3" aria-hidden="true" />
                {formatNearestTransmission(
                  nearestTransmission.voltageKv,
                  nearestTransmission.distanceMi,
                  { compact: true },
                )}
              </span>
            )}
          </p>
        )}

        {/* Capacity */}
        {capacityMw && (
          <div className="text-xs tabular-nums text-foreground mb-1 space-y-0.5">
            {capacityMw.operational !== undefined && (
              <p>{capacityMw.operational} MW operational</p>
            )}
            {capacityMw.planned !== undefined && (
              <p>{capacityMw.planned} MW planned</p>
            )}
          </div>
        )}

        {/* Type-specific detail: AI classification for data centers, mining/environmental
            signals for crypto-mining facilities. */}
        {facility.facilityType === "data_center" ? (
          <p className="text-xs text-foreground mb-2 capitalize">
            {facility.aiClassification
              ? `${facility.aiClassification.replace("_", " ")} · ${confidence}`
              : confidence}
          </p>
        ) : facility.facilityType === "crypto_mining" ? (
          <div className="text-xs text-foreground mb-2 space-y-0.5">
            {facility.mining?.hashRateThPerS !== undefined && (
              <p className="tabular-nums">
                {facility.mining.hashRateThPerS} TH/s
              </p>
            )}
            {facility.mining?.powerArrangement && (
              <p className="capitalize">
                {facility.mining.powerArrangement.replace(/_/g, " ")}
              </p>
            )}
            {facility.environmental?.carbonIntensityProxy !== undefined && (
              <p className="tabular-nums">
                Carbon proxy: {facility.environmental.carbonIntensityProxy}
              </p>
            )}
            <p className="capitalize">{confidence}</p>
          </div>
        ) : (
          <p className="text-xs text-foreground mb-2 capitalize">{confidence}</p>
        )}

        {/* Footer links. Both stand alone as the entire content of their
            link — unlike the map attribution links in facility-map.tsx,
            which sit inside a written sentence ("Imagery © Esri, Vantor…")
            and qualify for WCAG 2.5.8's "inline" (sentence-constrained)
            exception — these are discrete actions in a two-item action row,
            so they do NOT qualify and must meet the 24px floor. py-1.5
            brings each to 28px tall (16px line-height + 12px padding);
            width was already >24px (79px / 55px measured). */}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
          <Link
            href={`/facilities/${facility.id}`}
            className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded py-1.5"
          >
            View details →
          </Link>
          <a
            href={firstSource.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`${firstSource.label} (opens in new tab)`}
            className="text-xs text-foreground/80 hover:text-foreground flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded py-1.5"
          >
            <ExternalLink className="size-3" aria-hidden="true" />
            Source
          </a>
        </div>
      </div>
    </div>
  );
}
