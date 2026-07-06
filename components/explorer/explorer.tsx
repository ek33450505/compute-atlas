"use client";

import { useMemo } from "react";
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ExplorerProps {
  facilities: Facility[];
}

export function Explorer({ facilities }: ExplorerProps) {
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
