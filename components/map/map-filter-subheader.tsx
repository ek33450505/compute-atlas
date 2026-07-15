"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { FilterBar } from "@/components/explorer/filter-bar";
import type { FilterValues, FilterSetters } from "@/components/explorer/filter-bar";
import type { Facility } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MapFilterSubheaderProps {
  facilities: Facility[];
  values: FilterValues;
  setters: FilterSetters;
  filteredCount: number;
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Active filter count — mirrors FilterBar's logic
// ---------------------------------------------------------------------------

function countActiveFilters(values: FilterValues): number {
  return (
    values.status.length +
    values.state.length +
    values.operator.length +
    values.facilityType.length +
    (values.minMw > 0 ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// MapFilterSubheader
// ---------------------------------------------------------------------------

const BODY_ID = "map-filter-subheader-body";

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

/**
 * Collapsible filter sub-header for the /map immersive view.
 *
 * Renders in normal document flow BELOW the site header and ABOVE the map —
 * NOT as a floating overlay. The map flexes to fill the remaining viewport height.
 *
 * Design decisions:
 * - `border-b border-border bg-background` echoes the site-header aesthetic.
 * - Summary row is always visible: ⌖ glyph, title, active-count badge, live
 *   result count, "View as table →" cross-link, and the collapse/expand toggle.
 * - FilterBar body appears below the summary row only when expanded.
 * - Default: expanded on ≥640 px (sm), collapsed on mobile. A `typeof window`
 *   guard makes the matchMedia initializer SSR-safe; server renders expanded.
 * - Toggle button is ≥44 px (h-11 w-11) to meet the project's touch-target rule.
 * - Chevron rotation transition respects prefers-reduced-motion via
 *   `motion-reduce:transition-none`.
 */
export function MapFilterSubheader({
  facilities,
  values,
  setters,
  filteredCount,
  totalCount,
}: MapFilterSubheaderProps) {
  // Stable SSR-safe default: server (and first client render) reports expanded
  // so server and first client render agree (avoids hydration mismatch).
  // useSyncExternalStore then reads the real viewport-appropriate state once
  // the client has access to matchMedia, and stays subscribed to further
  // viewport changes (e.g. window resize across the 640px boundary).
  const prefersExpanded = useSyncExternalStore(
    subscribeWideViewport,
    getWideViewportSnapshot,
    getWideViewportServerSnapshot
  );
  // Manual toggle overrides the viewport-derived default until unmount.
  const [override, setOverride] = useState<boolean | null>(null);
  const isOpen = override ?? prefersExpanded;

  // Build the "View as table" href from the current filter values so filters
  // carry to /table via the URL. Derived from `values` (not useSearchParams)
  // so this component renders in isolation (unit tests) without an App Router
  // context; the param schema matches the nuqs parsers on /table.
  const tableParams = new URLSearchParams();
  if (values.status.length) tableParams.set("status", values.status.join(","));
  if (values.state.length) tableParams.set("state", values.state.join(","));
  if (values.operator.length) tableParams.set("operator", values.operator.join(","));
  if (values.facilityType.length) tableParams.set("facilityType", values.facilityType.join(","));
  if (values.minMw > 0) tableParams.set("minMw", String(values.minMw));
  const tableQs = tableParams.toString();
  const tableHref = tableQs ? `/table?${tableQs}` : "/table";

  const activeCount = countActiveFilters(values);

  return (
    <div className="border-b border-border bg-background">
      {/* ── Always-visible summary row ──────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 min-h-[44px]">
        {/* Cartographic crosshair glyph */}
        <span
          className="font-mono text-sm text-muted-foreground shrink-0"
          aria-hidden="true"
        >
          ⌖
        </span>

        {/* Section title */}
        <span className="font-mono text-xs font-semibold uppercase tracking-widest text-foreground shrink-0">
          Filters
        </span>

        {/* Active-filter count badge */}
        {activeCount > 0 && (
          <span
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-primary px-1 font-mono text-[10px] font-semibold text-primary-foreground shrink-0"
            aria-label={`${activeCount} active filter${activeCount === 1 ? "" : "s"}`}
          >
            {activeCount}
          </span>
        )}

        {/*
         * Live result count — always in DOM so aria-live fires on mobile too.
         * Visually hidden on mobile (sr-only) to avoid crowding the compact bar;
         * revealed on sm+ (not-sr-only).
         */}
        <p
          role="status"
          aria-live="polite"
          className="sr-only sm:not-sr-only sm:ml-1 shrink-0 font-mono text-xs text-muted-foreground"
        >
          Showing {filteredCount} of {totalCount} facilities
        </p>

        {/* Spacer */}
        <div className="flex-1 min-w-0" />

        {/* "View as table →" cross-link — hidden on mobile to keep bar compact */}
        <Link
          href={tableHref}
          className="hidden sm:block font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm shrink-0"
        >
          View as table →
        </Link>

        {/* Collapse / expand toggle — ≥44 px touch target */}
        <button
          type="button"
          onClick={() => setOverride((o) => !(o ?? prefersExpanded))}
          aria-expanded={isOpen}
          aria-controls={BODY_ID}
          aria-label={isOpen ? "Collapse filter controls" : "Expand filter controls"}
          className={[
            // ≥44 px hit target (WCAG 2.5.8)
            "flex h-11 w-11 items-center justify-center rounded-sm shrink-0",
            "text-muted-foreground",
            "hover:bg-muted hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            "transition-colors",
          ].join(" ")}
        >
          {/* Chevron — CSS rotation + transition with prefers-reduced-motion guard */}
          <span
            className={[
              "inline-flex transition-transform duration-150 ease-in-out motion-reduce:transition-none",
              isOpen ? "rotate-0" : "-rotate-90",
            ].join(" ")}
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
            >
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
      </div>

      {/* ── Collapsible FilterBar body ──────────────────────────────────── */}
      {isOpen && (
        <div id={BODY_ID} className="border-t border-border px-4 py-3">
          <FilterBar
            facilities={facilities}
            values={values}
            setters={setters}
          />
        </div>
      )}
    </div>
  );
}
