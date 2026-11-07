import type { Facility } from "@/lib/schema";
import { filterFacilities, getFilterOptions, type FilterOptions } from "@/lib/filters";
import { toTableRow, type TableRow } from "@/lib/facility-slim";
import { MAX_SEARCH_QUERY_LEN } from "@/lib/search-limits";
import type { Status } from "@/lib/status";
import { compareRows, type SortColumn, type SortDir } from "@/lib/table-sort";

export const PAGE_SIZE = 50;
/** Most pages /table will serve for any query, so no filter combination enumerates the dataset. */
export const MAX_PAGES = 10;
/** Most rows reachable through /table for any single query. */
export const MAX_ROWS = PAGE_SIZE * MAX_PAGES;

export interface TableQueryParams {
  status: Status[];
  state: string[];
  operator: string[];
  facilityType: Facility["facilityType"][];
  minMw: number;
  q: string;
  sort: SortColumn;
  dir: SortDir;
  page: number;
}

export interface TableQueryResult {
  rows: TableRow[];
  /** Rows matching the filters, before the `MAX_ROWS` cap. */
  filteredCount: number;
  /** Rows reachable by paging: `min(filteredCount, MAX_ROWS)`. */
  reachableCount: number;
  totalCount: number;
  page: number;
  pageCount: number;
  /** Filter options derived from the FULL set, so selecting a filter never hides its siblings. */
  options: FilterOptions;
}

/**
 * Filter, sort and paginate the full dataset for /table. Pure: the caller
 * supplies the facilities. Only the requested page is projected to `TableRow`.
 */
export function queryTable(all: Facility[], params: TableQueryParams): TableQueryResult {
  const filtered = filterFacilities(all, {
    statuses: params.status,
    states: params.state,
    operators: params.operator,
    facilityTypes: params.facilityType,
    minMw: params.minMw,
    query: params.q.trim().slice(0, MAX_SEARCH_QUERY_LEN),
  });

  // Sort projected rows so the comparators (which take TableRow) are the single
  // definition; project all matches, then slice. 2.7k records: cheap.
  const sorted = filtered.map(toTableRow).sort(compareRows(params.sort, params.dir));

  const reachableCount = Math.min(sorted.length, MAX_ROWS);
  const pageCount = Math.max(1, Math.ceil(reachableCount / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(params.page) || 1), pageCount);
  const rows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return {
    rows,
    filteredCount: sorted.length,
    reachableCount,
    totalCount: all.length,
    page,
    pageCount,
    options: getFilterOptions(all),
  };
}
