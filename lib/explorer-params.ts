import {
  createLoader,
  createParser,
  parseAsArrayOf,
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
} from "nuqs/server";

import { facilityTypeEnum } from "@/lib/schema";
import { MAX_SEARCH_QUERY_LEN } from "@/lib/search-limits";
import { STATUS_ORDER } from "@/lib/status";
import { SORT_COLUMNS } from "@/lib/table-sort";

/** Trimmed free-text query, capped before it reaches a cache key or Postgres. */
export function normalizeQuery(raw: string): string {
  return raw.trim().slice(0, MAX_SEARCH_QUERY_LEN);
}

const parseAsQuery = createParser<string>({
  parse: normalizeQuery,
  serialize: (v) => v,
});

/** Integer >= 1; anything else (0, negatives, fractions, junk) falls back to the default. */
const parseAsPage = createParser<number>({
  parse: (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : null;
  },
  serialize: (v) => String(v),
});

/**
 * Shared URL params for the Explorer. The first five keys and defaults match
 * the nuqs `useQueryState` calls in components/explorer/explorer.tsx so
 * existing share links keep working.
 */
export const explorerParsers = {
  status: parseAsArrayOf(parseAsStringLiteral(STATUS_ORDER)).withDefault([]),
  state: parseAsArrayOf(parseAsString).withDefault([]),
  operator: parseAsArrayOf(parseAsString).withDefault([]),
  facilityType: parseAsArrayOf(parseAsStringLiteral(facilityTypeEnum.options)).withDefault([]),
  minMw: parseAsInteger.withDefault(0),
  q: parseAsQuery.withDefault(""),
  sort: parseAsStringLiteral(SORT_COLUMNS).withDefault("capacity"),
  dir: parseAsStringLiteral(["asc", "desc"] as const).withDefault("desc"),
  page: parseAsPage.withDefault(1),
};

export const loadExplorerParams = createLoader(explorerParsers);
