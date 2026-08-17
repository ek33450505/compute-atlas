/**
 * Server-only search index builder. Deliberately kept OUT of `lib/search.ts`.
 *
 * `lib/search.ts` is imported by `components/search/command-palette.tsx`,
 * which is a `"use client"` component — so anything `lib/search.ts` imports
 * gets bundled for the browser. `loadFacilitiesForSearch` (from `@/lib/data`)
 * statically imports `data/facilities.json`, a ~2.8 MB dataset. Before this
 * split, that import chain (`command-palette.tsx` → `lib/search.ts` →
 * `@/lib/data` → `@/data/facilities.json`) dragged the entire dataset into
 * the client bundle shipped on every route via `SiteHeader` in the root
 * layout — a 748 KB brotli / 2.9 MB parsed JS chunk on every page.
 *
 * `buildSearchIndex` only ever runs server-side (called from `SiteHeader`,
 * a Server Component) and its result — a plain `SearchEntry[]` — is what
 * gets passed down as a prop to the client `CommandPalette`. So the data
 * read belongs here, not in `lib/search.ts`.
 *
 * DO NOT merge this file back into `lib/search.ts` and DO NOT import
 * `@/lib/data` (or anything that transitively imports `@/data/facilities.json`)
 * from `lib/search.ts` — doing so silently reintroduces the full dataset into
 * every client bundle with no build error to catch it.
 */
import { loadFacilitiesForSearch, operatorSlug } from "@/lib/data";
import { facilityToSearchEntry, type SearchEntry } from "@/lib/search";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

/**
 * Builds the data-backed search index: one entry per facility, operator, and
 * state. Does NOT include "page" entries — those are UI config supplied by
 * the command palette component, not data.
 */
export async function buildSearchIndex(): Promise<SearchEntry[]> {
  const facilities = await loadFacilitiesForSearch();
  const entries: SearchEntry[] = [];

  // Facilities — one entry each.
  for (const f of facilities) {
    entries.push(facilityToSearchEntry(f));
  }

  // Operators — count facilities per operator in one pass, and derive the
  // unique operator name list from the same `facilities` read (avoids a
  // second loadFacilities-family read that would re-pin the ISR floor).
  const operatorCounts = new Map<string, number>();
  for (const f of facilities) {
    operatorCounts.set(f.operator, (operatorCounts.get(f.operator) ?? 0) + 1);
  }
  const operatorNames = [...new Set(facilities.map((f) => f.operator))].sort();
  for (const name of operatorNames) {
    const n = operatorCounts.get(name) ?? 0;
    entries.push({
      type: "operator",
      label: name,
      sublabel: `${n} ${pluralize(n, "facility", "facilities")}`,
      href: `/operators/${operatorSlug(name)}`,
      keywords: name.toLowerCase(),
    });
  }

  // States — derive unique codes from facilities, skip any without a slug.
  const stateCounts = new Map<string, number>();
  for (const f of facilities) {
    const code = f.location.state;
    stateCounts.set(code, (stateCounts.get(code) ?? 0) + 1);
  }
  for (const [code, n] of stateCounts) {
    const slug = stateSlugFromCode(code);
    const stateName = stateNameFromCode(code);
    if (!slug || !stateName) continue;
    entries.push({
      type: "state",
      label: stateName,
      sublabel: `${n} ${pluralize(n, "facility", "facilities")}`,
      href: `/states/${slug}`,
      keywords: `${stateName} ${code}`.toLowerCase(),
    });
  }

  return entries;
}
