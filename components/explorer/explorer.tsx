"use client";

import { useMemo } from "react";
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
  // Map-only mode (no toggle)
  // -------------------------------------------------------------------------
  if (mode === "map") {
    return (
      <div className="space-y-4">
        <FilterBar
          facilities={facilities}
          values={{ status, state, operator, minMw, q }}
          setters={{ setStatus, setState, setOperator, setMinMw, setQ }}
        />

        {/* Result count + cross-link row */}
        <div className="flex items-center justify-between gap-4">
          <p
            role="status"
            aria-live="polite"
            className="text-sm text-muted-foreground"
          >
            Showing {filtered.length} of {facilities.length} facilities
          </p>
          <Link
            href="/table"
            className="font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            View as table →
          </Link>
        </div>

        <section aria-label="Interactive datacenter map">
          <FacilityMap
            facilities={filtered}
            heightClass="h-[calc(100dvh-15rem)] min-h-[520px]"
          />
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
