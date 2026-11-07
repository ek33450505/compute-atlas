"use client";

import { useLayoutEffect, useMemo, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useQueryStates } from "nuqs";

import { filterMapPoints, type FilterOptions } from "@/lib/filters";
import { explorerParsers } from "@/lib/explorer-params";
import type { MapPoint, TableRow } from "@/lib/facility-slim";
import type { SortColumn, SortDir } from "@/lib/table-sort";
import { PAGE_SIZE } from "@/lib/table-query";
import { FacilityTable } from "@/components/table/facility-table";
import { TablePagination } from "@/components/table/table-pagination";
import { FacilityMap } from "@/components/map/facility-map-dynamic";
import { FilterBar } from "@/components/explorer/filter-bar";
import { useMatchedIds } from "@/components/explorer/use-matched-ids";
import { MapFilterSubheader } from "@/components/map/map-filter-subheader";
import { ShareLinkButton } from "@/components/explorer/share-link-button";
import { StatePanel } from "@/components/feedback/state-panel";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `mode` selects the view.
 *  - "map": FilterBar + map over `MapPoint[]` (id, type, status, state, coords).
 *    Status/state/type filter locally; operator and minimum MW resolve through
 *    `/api/map/match` (see use-matched-ids.ts) because the client holds no names.
 *  - "table": renders one server-provided page of rows (lib/table-query.ts).
 *    Filter/sort/search changes write the URL with `shallow: false`, so the
 *    server re-queries; no filtering happens on the client.
 */
interface TableModeProps {
  mode: "table";
  rows: TableRow[];
  filteredCount: number;
  reachableCount: number;
  totalCount: number;
  page: number;
  pageCount: number;
  options: FilterOptions;
  sort: SortColumn;
  dir: SortDir;
  q: string;
}

type ExplorerProps = { mode: "map"; points: MapPoint[]; options: FilterOptions } | TableModeProps;

const BASE_NUMBER = (n: number) => n.toLocaleString("en-US");

export function Explorer(props: ExplorerProps) {
  const mode = props.mode;
  const [isPending, startTransition] = useTransition();
  // Table mode re-renders on the server (shallow: false) inside a transition so
  // `isPending` can mark the table busy; map mode filters client-side.
  const [params, setParams] = useQueryStates(
    explorerParsers,
    mode === "table" ? { shallow: false, startTransition } : { shallow: true }
  );
  const { status, state, operator, facilityType, minMw } = params;

  const searchParams = useSearchParams();

  // Any filter or search change returns to page 1.
  const setStatus = (v: typeof status) => setParams({ status: v, page: null });
  const setState = (v: typeof state) => setParams({ state: v, page: null });
  const setOperator = (v: typeof operator) => setParams({ operator: v, page: null });
  const setFacilityType = (v: typeof facilityType) =>
    setParams({ facilityType: v, page: null });
  const setMinMw = (v: number) => setParams({ minMw: v, page: null });
  const setQ = (v: string) => setParams({ q: v, page: null });

  const mapPoints = props.mode === "map" ? props.points : null;
  const match = useMatchedIds(mode === "map" ? operator : [], mode === "map" ? minMw : 0);
  const matchedIds = match.ids;
  // First lookup for a deep link: nothing to show yet, and unfiltered would be wrong.
  const applying = match.pending && matchedIds === null;
  const mapRowsOrNull = useMemo(() => {
    if (!mapPoints) return null;
    const local = filterMapPoints(mapPoints, {
      statuses: status,
      states: state,
      facilityTypes: facilityType,
    });
    if (applying) return [];
    return matchedIds ? local.filter((p) => matchedIds.has(p.id)) : local;
  }, [mapPoints, status, state, facilityType, matchedIds, applying]);

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

  const clearAll = () =>
    setParams({ status: null, state: null, operator: null, facilityType: null, minMw: null, q: null, page: null });

  // -------------------------------------------------------------------------
  // Map-only mode — immersive full-bleed layout
  // Filter sub-header sits in normal document flow ABOVE the map; the map
  // flexes to fill the remaining viewport height below the site header (4 rem).
  // -------------------------------------------------------------------------
  if (props.mode === "map") {
    const { points, options } = props;
    const mapRows = mapRowsOrNull ?? [];
    return (
      <div
        data-testid="map-shell"
        className="flex flex-col overflow-hidden h-[calc(100dvh-4rem)] supports-[height:100svh]:h-[calc(100svh-4rem)]"
        style={mapShellHeight !== null ? { height: mapShellHeight } : undefined}
      >
        <MapFilterSubheader
          options={options}
          values={{ status, state, operator, facilityType, minMw }}
          setters={{ setStatus, setState, setOperator, setFacilityType, setMinMw }}
          filteredCount={mapRows.length}
          totalCount={points.length}
          applying={applying}
          lookupFailed={match.error}
        />
        {mapRows.length === 0 && !applying ? (
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
                facilities={mapRows}
                heightClass="h-full"
                surveyOnMount={mapRows.length !== points.length}
                // Same "is this a real subset of the full dataset" question
                // surveyOnMount already answers above — isFiltered feeds the
                // SAME expression to the ongoing (post-mount) survey-pass
                // effect, so clearing the last filter returns the camera to
                // the default CONUS view instead of fitting bounds around
                // the full AK-to-HI dataset. See the isFiltered doc comment
                // on FacilityMapProps (components/map/facility-map.tsx) for
                // the full rationale and its known limitation.
                isFiltered={mapRows.length !== points.length}
              />
            </section>
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Table mode — /table page.
  // Shares the nuqs URL schema with /map; the "View map" cross-link copies the
  // filter params (not page/sort/search) so filters carry between the views.
  // -------------------------------------------------------------------------
  const { rows, filteredCount, reachableCount, page, pageCount, options, sort, dir, q } = props;
  const query = searchParams.toString();
  const mapParams = new URLSearchParams(query);
  for (const k of ["page", "sort", "dir", "q"]) mapParams.delete(k);
  const mapQs = mapParams.toString();
  const mapHref = mapQs ? `/map?${mapQs}` : "/map";
  const first = (page - 1) * PAGE_SIZE + 1;
  const summary =
    filteredCount === 0
      ? "No facilities match these filters"
      : `Showing ${BASE_NUMBER(first)}–${BASE_NUMBER(first + rows.length - 1)} of ${BASE_NUMBER(filteredCount)} facilities${
          filteredCount > reachableCount
            ? `. Only the first ${BASE_NUMBER(reachableCount)} are listed; narrow the filters or search to see the rest.`
            : ""
        }`;

  return (
    <div className="space-y-4">
      <Link
        href={mapHref}
        className="inline-flex items-center gap-1 rounded-sm font-mono text-xs uppercase tracking-wider text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        ← View map
      </Link>
      <FilterBar
        options={options}
        values={{ status, state, operator, facilityType, minMw }}
        setters={{ setStatus, setState, setOperator, setFacilityType, setMinMw }}
        search={{ value: q, onChange: setQ }}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          role="status"
          aria-live="polite"
          className="font-mono text-xs uppercase tracking-wider text-muted-foreground"
        >
          {summary}
        </p>
        <ShareLinkButton />
      </div>
      <section aria-label="Facilities data table" aria-busy={isPending}>
        <FacilityTable
          facilities={rows}
          sort={sort}
          dir={dir}
          onSort={(column, nextDir) => setParams({ sort: column, dir: nextDir, page: null })}
        />
      </section>
      <TablePagination page={page} pageCount={pageCount} query={query} />
    </div>
  );
}
