import type { Facility } from "@/lib/schema";
import { operatorSlug } from "@/lib/operator-slug";

/**
 * The cache-tag vocabulary, in one place.
 *
 * Three parties have to agree on these exact strings or a write silently
 * fails to refresh a page:
 *
 * - **Producers** — the `unstable_cache` wrappers in `lib/data.ts` that stamp
 *   each cached read with its tags.
 * - **The on-write buster** — `revalidateForFacility` in
 *   `lib/facility-write.ts`, which runs inside the Next runtime and can call
 *   `revalidateTag` directly.
 * - **The out-of-band buster** — `POST /api/revalidate`, which bulk CLIs
 *   (`scripts/sync-to-neon.ts`) call over HTTP because a plain `tsx` process
 *   has no Next runtime and therefore no `revalidateTag`.
 *
 * Before this module the producer logic and the route's validation allowlist
 * were two independent copies of the same rules, so a tag the app happily
 * busts could be a tag the route rejects. They are now the same source.
 *
 * Deliberately dependency-free apart from a **type-only** import and
 * `operatorSlug` (itself a zero-dependency leaf in `lib/operator-slug.ts`):
 * `tsx` CLIs import this without dragging in `next/cache`, which only
 * resolves inside the Next.js runtime.
 */

/** Tags with no dynamic part. */
const LITERAL_TAGS = new Set(["facilities", "power-generation"]);

/**
 * Shapes of the parameterized tags. Facility ids are lowercase slugs and
 * state codes are 2-letter uppercase — both enforced upstream by
 * `facilitySchema`, so a tag failing these patterns means bad data, not a
 * missing case.
 */
const TAG_PATTERNS = [
  /^state:[A-Z]{2}$/,
  /^facility:[a-z0-9-]+$/,
  /^operator:[a-z0-9-]+$/,
];

/**
 * Hard cap on tags accepted per `POST /api/revalidate` call — bounds the
 * route's synchronous `revalidateTag` loop. Bulk callers batch to this size.
 */
export const MAX_TAGS_PER_REQUEST = 100;

/**
 * Whether `tag` is a tag this codebase actually produces. The revalidate
 * route rejects anything outside this allowlist rather than silently
 * dropping it, so a typo'd tag surfaces immediately instead of quietly
 * no-op'ing; bulk callers run the same check *before* writing, so a bad tag
 * can never leave rows written with their pages un-busted.
 */
export function isValidCacheTag(tag: string): boolean {
  return LITERAL_TAGS.has(tag) || TAG_PATTERNS.some((pattern) => pattern.test(tag));
}

/**
 * The exact set of tags one facility write invalidates — the scoped
 * alternative to the old global `"facilities"` nuke, which shrank a write's
 * blast radius from the whole ~1,547-route surface to up to 6 scoped tags
 * (facility, new + previous state, new + previous operator, and
 * `power-generation` when either side qualifies — see below).
 *
 * `"facilities"` is deliberately NOT included: aggregate pages (home, map,
 * table, stats, ...) refresh on their own cheap `revalidate: 3600` timer
 * (see `loadFacilities` in `lib/data.ts`) — an approved ~1h freshness
 * tolerance (Ed, 2026-07-22 ISR-write-blowout fix). A caller that genuinely
 * wants aggregates refreshed now — e.g. a one-shot bulk sync, where the
 * amplification argument runs the other way — adds it once itself.
 *
 * - Always `facility:${doc.id}` (the detail page),
 *   `state:${doc.location.state}` (the new/current state's landing page),
 *   and `operator:${operatorSlug(doc.operator)}` (that operator's entries in
 *   the related-facilities rail — `getFacilitiesByOperatorCached` in
 *   `lib/data.ts`).
 * - If `prevDoc` is given and sat in a different state, also the *old*
 *   state's tag — otherwise a facility that moved states leaves a stale
 *   entry on its old state's landing page. Same reasoning for operator: if
 *   `prevDoc` had a different operator, also the *old* operator's tag,
 *   otherwise a facility that changes operator leaves a stale entry on its
 *   old operator's related-facilities rail.
 * - If either side is a `power_generation` facility, also `power-generation`
 *   — the shared tag backing the facility detail page's "Powered by"/"Powers"
 *   cross-reference (`loadPowerGenerationCached` in `lib/data.ts`), on either
 *   end of a `poweredFacilityIds` link.
 *
 * Returns de-duplicated tags; order is not significant.
 */
export function tagsForFacility(doc: Facility, prevDoc?: Facility): string[] {
  const tags = new Set<string>([
    `facility:${doc.id}`,
    `state:${doc.location.state.toUpperCase()}`,
    `operator:${operatorSlug(doc.operator)}`,
  ]);

  if (prevDoc) {
    tags.add(`state:${prevDoc.location.state.toUpperCase()}`);
    tags.add(`operator:${operatorSlug(prevDoc.operator)}`);
  }

  if (doc.facilityType === "power_generation" || prevDoc?.facilityType === "power_generation") {
    tags.add("power-generation");
  }

  return [...tags];
}
