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
 * `buildNavSearchIndex` only ever runs server-side (called from `SiteHeader`,
 * a Server Component) and its result — a plain `SearchEntry[]` — is what
 * gets passed down as a prop to the client `CommandPalette`. So the data
 * read belongs here, not in `lib/search.ts`.
 *
 * DO NOT merge this file back into `lib/search.ts` and DO NOT import
 * `@/lib/data` (or anything that transitively imports `@/data/facilities.json`)
 * from `lib/search.ts` — doing so silently reintroduces the full dataset into
 * every client bundle with no build error to catch it.
 *
 * A second, distinct cost survived that split: the built index was still
 * SERIALIZED into the RSC payload of every route as a `CommandPalette` prop.
 * Measured 2026-08-17 against the 1034-facility dataset, that was ~1430
 * entries per route (1034 facilities + 346 operators + 50 states) on all
 * ~1486 routes (dated — the route count has since grown to ~1,547, see the
 * ground-truth table on the 2026-08-21 edge-cache-tag fix; the shape of the
 * saving is unchanged); the nav-only index below is ~396 (operators + states).
 * (An earlier revision of this comment said "~1062 entries, 1034 of them
 * facilities" — that 1062 was a count of the string `facilities/` in the
 * rendered HTML, not the index size.) `SiteHeader`
 * therefore calls `buildNavSearchIndex()` (operators + states only) and
 * facility results come from `/api/search`, which prefix-matches as you type
 * (`buildTsQuery` in lib/search-db.ts).
 *
 * There is deliberately NO facility-inclusive builder here any more. The one
 * that existed (`buildSearchIndex`) had no callers left but the tests once
 * `SiteHeader` switched over, and an exported-but-unused server-side index
 * builder is precisely the thing that gets quietly re-wired into a client prop
 * later — which is the defect this whole file exists to prevent. Facilities
 * are served by `/api/search`, full stop; if you find yourself re-adding a
 * builder that walks every facility into `SearchEntry[]`, that is the
 * regression, not the fix.
 *
 * `loadFacilitiesForSearch` above is the reader this index is built from,
 * and it is deliberately UNTAGGED — it refreshes only on its own 86400s
 * `revalidate` timer, not on a per-facility cache-tag bust (see the comment
 * on `loadFacilitiesForSearch` in `lib/data.ts` for why: it once carried the
 * global `"facilities"` tag and that turned every bulk sync into a
 * site-wide cache nuke). Because it runs in the root layout, its 86400s
 * timer is also the effective staleness floor for every other route on the
 * site, regardless of that route's own `revalidate`/tag config. If you find
 * yourself tempted to tag this reader again — e.g. so a single write can
 * refresh the nav index immediately — remember that tag would be stamped
 * onto every route's render tree, not scoped to the routes that actually
 * changed.
 */
import { loadFacilitiesForSearch, operatorSlug } from "@/lib/data";
import { type SearchEntry } from "@/lib/search";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

/**
 * The nav index shipped to the client `CommandPalette`: operators and states
 * derived from the facility dataset, with no per-facility entries. Does NOT
 * include "page" entries either — those are UI config supplied by the command
 * palette component, not data.
 */
export async function buildNavSearchIndex(): Promise<SearchEntry[]> {
  const facilities = await loadFacilitiesForSearch();
  const entries: SearchEntry[] = [];

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
