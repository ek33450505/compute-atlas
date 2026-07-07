"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  useQueryState,
  parseAsStringLiteral,
  parseAsArrayOf,
  parseAsString,
  parseAsInteger,
} from "nuqs";

import { filterFacilities } from "@/lib/filters";
import { STATUS_ORDER } from "@/lib/status";
import type { Facility } from "@/lib/schema";
import { FacilityTable } from "@/components/table/facility-table";
import { FacilityMap } from "@/components/map/facility-map-dynamic";
import { FilterBar } from "@/components/explorer/filter-bar";
import { MapFilterSubheader } from "@/components/map/map-filter-subheader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VIEW_VALUES = ["map", "table"] as const;
type ViewValue = (typeof VIEW_VALUES)[number];

type ExplorerMode = "toggle" | "map" | "table";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ExplorerProps {
  facilities: Facility[];
  /** Controls whether the view-toggle UI is rendered.
   *  - "toggle" (default): renders Map/Table toggle buttons (existing behavior)
   *  - "map": renders FilterBar + map only; toggle buttons replaced by a cross-link
   *  - "table": reserved; toggle hidden, table rendered
   */
  mode?: ExplorerMode;
}

export function Explorer({ facilities, mode = "toggle" }: ExplorerProps) {
  const [view, setView] = useQueryState<ViewValue>(
    "view",
    parseAsStringLiteral(VIEW_VALUES).withDefault("map")
  );
  const [status, setStatus] = useQueryState(
    "status",
    parseAsArrayOf(parseAsStringLiteral(STATUS_ORDER)).withDefault([])
  );
  const [state, setState] = useQueryState(
    "state",
    parseAsArrayOf(parseAsString).withDefault([])
  );
  const [operator, setOperator] = useQueryState(
    "operator",
    parseAsArrayOf(parseAsString).withDefault([])
  );
  const [minMw, setMinMw] = useQueryState(
    "minMw",
    parseAsInteger.withDefault(0)
  );
  const [q, setQ] = useQueryState("q", parseAsString.withDefault(""));

  const searchParams = useSearchParams();

  const filtered = useMemo(
    () =>
      filterFacilities(facilities, {
        statuses: status,
        states: state,
        operators: operator,
        minMw,
        query: q,
      }),
    [facilities, status, state, operator, minMw, q]
  );

  // -------------------------------------------------------------------------
  // Map-only mode — immersive full-bleed layout (Phase 1c)
  // Filter sub-header sits in normal document flow ABOVE the map; the map
  // flexes to fill the remaining viewport height below the site header (4 rem).
  // -------------------------------------------------------------------------
  if (mode === "map") {
    return (
      <div className="flex flex-col h-[calc(100dvh-4rem)]">
        <MapFilterSubheader
          facilities={facilities}
          values={{ status, state, operator, minMw, q }}
          setters={{ setStatus, setState, setOperator, setMinMw, setQ }}
          filteredCount={filtered.length}
          totalCount={facilities.length}
        />
        {/* min-h-0 prevents the flex child from overflowing its parent */}
        <div className="relative flex-1 min-h-0">
          <section aria-label="Interactive datacenter map" className="h-full">
            <FacilityMap facilities={filtered} heightClass="h-full min-h-[320px]" />
          </section>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Table-only mode — /table page (Phase 1d(b)).
  // Reuses the shared nuqs filter state so /map and /table share one URL
  // schema; the "View map" cross-link copies the current query so filters
  // carry between the two views.
  // -------------------------------------------------------------------------
  if (mode === "table") {
    const qs = searchParams.toString();
    const mapHref = qs ? `/map?${qs}` : "/map";

    return (
      <div className="space-y-4">
        <Link
          href={mapHref}
          className="inline-flex items-center gap-1 rounded-sm font-mono text-xs uppercase tracking-wider text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          ← View map
        </Link>
        <FilterBar
          facilities={facilities}
          values={{ status, state, operator, minMw, q }}
          setters={{ setStatus, setState, setOperator, setMinMw, setQ }}
        />
        <p
          role="status"
          aria-live="polite"
          className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
        >
          Showing {filtered.length} of {facilities.length} facilities
        </p>
        <section aria-label="Facilities data table">
          <FacilityTable facilities={filtered} />
        </section>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Toggle mode (default — unchanged behavior)
  // -------------------------------------------------------------------------
  return (
    <div className="space-y-4">
      <FilterBar
        facilities={facilities}
        values={{ status, state, operator, minMw, q }}
        setters={{ setStatus, setState, setOperator, setMinMw, setQ }}
      />

      {/* Result count — live region so screen readers announce changes */}
      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        Showing {filtered.length} of {facilities.length} facilities
      </p>

      {/* View toggle */}
      <div
        role="group"
        aria-label="View"
        className="inline-flex rounded-md border border-border overflow-hidden"
      >
        <button
          type="button"
          aria-pressed={view === "map"}
          onClick={() => setView("map")}
          className="px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 aria-pressed:bg-foreground aria-pressed:text-background hover:bg-muted disabled:opacity-50"
        >
          Map view
        </button>
        <button
          type="button"
          aria-pressed={view === "table"}
          onClick={() => setView("table")}
          className="px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 aria-pressed:bg-foreground aria-pressed:text-background hover:bg-muted disabled:opacity-50 border-l border-border"
        >
          Table view
        </button>
      </div>

      {/* Active view */}
      {view === "table" ? (
        <FacilityTable facilities={filtered} />
      ) : (
        <section aria-label="Interactive datacenter map">
          <FacilityMap facilities={filtered} />
        </section>
      )}
    </div>
  );
}
