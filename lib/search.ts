import Fuse from "fuse.js";
import { stateNameFromCode } from "@/lib/us-states";
import type { Facility } from "@/lib/schema";

/** The kind of thing a search result points to. */
export type SearchEntryType = "page" | "facility" | "operator" | "state";

/** One indexed, searchable/navigable entry in the command palette. */
export interface SearchEntry {
  type: SearchEntryType;
  label: string;
  sublabel?: string;
  href: string;
  keywords: string;
}

/** One ranked group of results, in display order. */
export interface SearchResultGroup {
  type: SearchEntryType;
  label: string;
  items: SearchEntry[];
}

export const SEARCH_GROUP_LABELS: Record<SearchEntryType, string> = {
  page: "Pages",
  facility: "Facilities",
  operator: "Operators",
  state: "States",
};

/** Group render order for the ranked (non-empty-query) results view. */
const GROUP_ORDER: SearchEntryType[] = ["page", "facility", "operator", "state"];

/** Default per-group result caps for a ranked search. */
const DEFAULT_LIMITS: Record<SearchEntryType, number> = {
  page: 6,
  facility: 7,
  operator: 5,
  state: 5,
};

/** Builds one facility SearchEntry. The single place a Facility becomes a
 * palette entry — used by the live /api/search merge path in
 * command-palette.tsx. Pure — depends only on stateNameFromCode. */
export function facilityToSearchEntry(f: Facility): SearchEntry {
  const stateName = stateNameFromCode(f.location.state) ?? f.location.state;
  const sublabel = [f.location.city, stateName].filter(Boolean).join(", ");
  const keywords = [
    f.name,
    f.operator,
    f.location.city,
    f.location.county,
    f.location.street,
    stateName,
    f.location.state,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return {
    type: "facility",
    label: f.name,
    sublabel: sublabel || undefined,
    href: `/facilities/${f.id}`,
    keywords,
  };
}

/**
 * Ranks and groups `entries` against `query`. Pure — builds its own Fuse
 * instance from the passed entries, so it's fully testable without DOM.
 *
 * Empty/whitespace query returns only the "page" group (quick-nav state).
 * Non-empty query fuzzy-ranks across ALL entries, then regroups by type in
 * GROUP_ORDER, preserving Fuse rank within each group and capping by `limits`.
 */
export function searchCommands(
  entries: SearchEntry[],
  query: string,
  limits?: Partial<Record<SearchEntryType, number>>
): SearchResultGroup[] {
  const trimmed = query.trim();

  if (!trimmed) {
    const pages = entries.filter((e) => e.type === "page");
    if (pages.length === 0) return [];
    return [{ type: "page", label: SEARCH_GROUP_LABELS.page, items: pages }];
  }

  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };

  const fuse = new Fuse(entries, {
    keys: [
      { name: "label", weight: 0.7 },
      { name: "keywords", weight: 0.3 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
    includeScore: true,
  });

  const hits = fuse.search(trimmed).map((r) => r.item);

  const groups: SearchResultGroup[] = [];
  for (const type of GROUP_ORDER) {
    const cap = effectiveLimits[type];
    const items = hits.filter((e) => e.type === type).slice(0, cap);
    if (items.length > 0) {
      groups.push({ type, label: SEARCH_GROUP_LABELS[type], items });
    }
  }
  return groups;
}

/**
 * Folds DB full-text facility results (already ranked by ts_rank, so kept in
 * their given order) into the Fuse-ranked `groups`: appended AFTER the Fuse
 * facility hits, deduped by href, capped at `cap`. If the Fuse groups had no
 * facility group but DB results exist, a facility group is inserted in
 * GROUP_ORDER position. No-op (returns `groups` as-is) when `dbEntries` is
 * empty. Pure — no fetching. Other groups (page/operator/state) pass through
 * untouched, preserving GROUP_ORDER.
 */
export function mergeFacilityResults(
  groups: SearchResultGroup[],
  dbEntries: SearchEntry[],
  cap = 10
): SearchResultGroup[] {
  if (dbEntries.length === 0) return groups;
  const byType = new Map(groups.map((g) => [g.type, g] as const));
  const existing = byType.get("facility")?.items ?? [];
  const seen = new Set(existing.map((e) => e.href));
  const mergedItems = [...existing];
  for (const e of dbEntries) {
    if (mergedItems.length >= cap) break;
    if (seen.has(e.href)) continue;
    seen.add(e.href);
    mergedItems.push(e);
  }
  const result: SearchResultGroup[] = [];
  for (const type of GROUP_ORDER) {
    if (type === "facility") {
      if (mergedItems.length > 0) {
        result.push({ type: "facility", label: SEARCH_GROUP_LABELS.facility, items: mergedItems });
      }
    } else {
      const g = byType.get(type);
      if (g && g.items.length > 0) result.push(g);
    }
  }
  return result;
}
