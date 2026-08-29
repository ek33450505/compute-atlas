"use client";

import { useLayoutEffect, useMemo, useState } from "react";
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
import { facilityTypeEnum } from "@/lib/schema";
import { FacilityTable } from "@/components/table/facility-table";
import { FacilityMap } from "@/components/map/facility-map-dynamic";
import { FilterBar } from "@/components/explorer/filter-bar";
import { MapFilterSubheader } from "@/components/map/map-filter-subheader";
import { ExportButtons } from "@/components/explorer/export-buttons";
import { ShareLinkButton } from "@/components/explorer/share-link-button";
import { StatePanel } from "@/components/feedback/state-panel";
import { Button } from "@/components/ui/button";

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
  const [facilityType, setFacilityType] = useQueryState(
    "facilityType",
    parseAsArrayOf(parseAsStringLiteral(facilityTypeEnum.options)).withDefault([])
  );
  const [minMw, setMinMw] = useQueryState(
    "minMw",
    parseAsInteger.withDefault(0)
  );

  const searchParams = useSearchParams();

  const filtered = useMemo(
    () =>
      filterFacilities(facilities, {
        statuses: status,
        states: state,
        operators: operator,
        facilityTypes: facilityType,
        minMw,
      }),
    [facilities, status, state, operator, facilityType, minMw]
  );

  // m13: the map-mode shell below subtracts a hardcoded header height
  // (`4rem` = 64px) from the viewport height, but the real sticky header
  // (components/site-header.tsx) is `h-16` (64px) PLUS a `border-b` (1px)
  // = 65px — so `scrollHeight` was 1px taller than `clientHeight` on every
  // viewport, enough to trigger iOS's address-bar bounce on a route built
  // to be exactly one viewport tall. Measured live (not just corrected to
  // `4rem + 1px`) so this self-heals if the header's own height ever
  // changes again — the failure mode this is meant to avoid is a second
  // hardcoded number quietly drifting out of sync with a file this
  // component doesn't own. Only relevant to the "map" shell below, so
  // gated on `mode` to skip the DOM query in the other render modes; still
  // declared unconditionally (before any early return) per the rules of
  // hooks. Falls back to the original `4rem` constant (today's slightly-off
  // value) via the `mapShellHeight` ternary below until this resolves, or
  // if no `<header>` is ever found.
  const [mapShellHeight, setMapShellHeight] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (mode !== "map") return;
    const header = document.querySelector("header");
    if (!header) return;
    function recompute() {
      const headerHeight = header!.getBoundingClientRect().height;
      // Mirrors the `supports-[height:100svh]` CSS variant this replaces:
      // prefer the stable `svh` unit where supported (avoids reflow as a
      // mobile browser's chrome shows/hides), falling back to `dvh`.
      const svhSupported =
        typeof CSS !== "undefined" && typeof CSS.supports === "function"
          ? CSS.supports("height", "100svh")
          : false;
      const unit = svhSupported ? "svh" : "dvh";
      setMapShellHeight(`calc(100${unit} - ${headerHeight}px)`);
    }
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [mode]);

  const clearAll = () => {
    setStatus([]);
    setState([]);
    setOperator([]);
    setFacilityType([]);
    setMinMw(0);
  };

  // -------------------------------------------------------------------------
  // Map-only mode — immersive full-bleed layout (Phase 1c)
  // Filter sub-header sits in normal document flow ABOVE the map; the map
  // flexes to fill the remaining viewport height below the site header (4 rem).
  // -------------------------------------------------------------------------
  if (mode === "map") {
    return (
      <div
        data-testid="map-shell"
        className="flex flex-col overflow-hidden h-[calc(100dvh-4rem)] supports-[height:100svh]:h-[calc(100svh-4rem)]"
        style={mapShellHeight !== null ? { height: mapShellHeight } : undefined}
      >
        <MapFilterSubheader
          facilities={facilities}
          values={{ status, state, operator, facilityType, minMw }}
          setters={{ setStatus, setState, setOperator, setFacilityType, setMinMw }}
          filteredCount={filtered.length}
          totalCount={facilities.length}
        />
        {filtered.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <StatePanel
              titleAs="p"
              eyebrow="No results"
              title="No facilities match these filters"
              description="Try widening or clearing the filters to see facilities on the map."
              actions={
                <Button variant="outline" onClick={clearAll}>
                  Clear all filters
                </Button>
              }
            />
          </div>
        ) : (
          // min-h-0 prevents the flex child from overflowing its parent
          <div className="relative flex-1 min-h-0">
            <section aria-label="Interactive datacenter map" className="h-full">
              {/* heightClass is plain h-full — NOT min-h-[something] — on purpose.
                  This box already IS the flex-1 remainder of a fixed-height column
                  (h-[calc(100dvh-4rem)] minus the subheader above), so h-full gives
                  it exactly the space that's really there. An arbitrary min-height
                  floor here would force the map taller than that remainder on short
                  viewports (landscape phones: as little as ~187px available), and
                  since the ancestor column is overflow-hidden, the excess doesn't
                  scroll into view — it silently pushes the legend/scale bar/OSM
                  attribution below the fold instead. */}
              <FacilityMap
                facilities={filtered}
                heightClass="h-full"
                surveyOnMount={filtered.length !== facilities.length}
                // Same "is this a real subset of the full dataset" question
                // surveyOnMount already answers above — isFiltered feeds the
                // SAME expression to the ongoing (post-mount) survey-pass
                // effect, so clearing the last filter returns the camera to
                // the default CONUS view instead of fitting bounds around
                // the full AK-to-HI dataset. See the isFiltered doc comment
                // on FacilityMapProps (components/map/facility-map.tsx) for
                // the full rationale and its known limitation.
                isFiltered={filtered.length !== facilities.length}
              />
            </section>
          </div>
        )}
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
          values={{ status, state, operator, facilityType, minMw }}
          setters={{ setStatus, setState, setOperator, setFacilityType, setMinMw }}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            role="status"
            aria-live="polite"
            className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
          >
            Showing {filtered.length} of {facilities.length} facilities
          </p>
          <div className="flex items-center gap-2">
            <ExportButtons facilities={filtered} />
            <ShareLinkButton />
          </div>
        </div>
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
        values={{ status, state, operator, facilityType, minMw }}
        setters={{ setStatus, setState, setOperator, setFacilityType, setMinMw }}
      />

      {/* Result count — live region so screen readers announce changes */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          Showing {filtered.length} of {facilities.length} facilities
        </p>
        {view === "table" && (
          <div className="flex items-center gap-2">
            <ExportButtons facilities={filtered} />
            <ShareLinkButton />
          </div>
        )}
      </div>

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
      ) : filtered.length === 0 ? (
        <div className="flex h-[70vh] min-h-[420px] items-center justify-center">
          <StatePanel
            titleAs="p"
            eyebrow="No results"
            title="No facilities match these filters"
            description="Try widening or clearing the filters to see facilities on the map."
            actions={
              <Button variant="outline" onClick={clearAll}>
                Clear all filters
              </Button>
            }
          />
        </div>
      ) : (
        <section aria-label="Interactive datacenter map">
          {/* isFiltered mirrors the map-mode branch above — same `filtered`/
              `facilities` computed once at the top of this component, so the
              "is this a real subset" question means the same thing in every
              mode. This branch intentionally does NOT pass surveyOnMount or
              heightClass: those are unrelated to isFiltered and specific to
              the map-only route's full-bleed, deep-link-aware layout. */}
          <FacilityMap facilities={filtered} isFiltered={filtered.length !== facilities.length} />
        </section>
      )}
    </div>
  );
}
