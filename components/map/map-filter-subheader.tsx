"use client";

import { useState, useEffect } from "react";
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
    (values.minMw > 0 ? 1 : 0) +
    (values.q.trim().length > 0 ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// MapFilterSubheader
// ---------------------------------------------------------------------------

const BODY_ID = "map-filter-subheader-body";

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
  // Stable SSR-safe default: always start expanded so server and first client
  // render agree (avoids hydration mismatch). A mount effect then sets the
  // real viewport-appropriate state once the client has access to matchMedia.
  const [isOpen, setIsOpen] = useState(true);
  useEffect(() => {
    setIsOpen(window.matchMedia("(min-width: 640px)").matches);
  }, []);

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
          href="/table"
          className="hidden sm:block font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm shrink-0"
        >
          View as table →
        </Link>

        {/* Collapse / expand toggle — ≥44 px touch target */}
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
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
