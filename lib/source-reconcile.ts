import { canonicalStringify } from "@/lib/canonical-json";
import { remapSourceIndices, sourceIndexRefs, type SourceIndexCarrier } from "@/lib/schema";

/**
 * `mergeFacilityPatch` is a shallow merge, so a patch that reorders or shortens
 * `sources` leaves every CARRIED field's `sourceIndex` (one the patch does not
 * itself state: it came from the stored doc via the merge or
 * `carryCuratedKeys`) pointing at the old positions. This module decides, per
 * carried ref, whether it still cites the same source.
 *
 * Rules:
 * - A ref the patch states at that exact path is the patch author's
 *   responsibility: it is kept as written and never remapped
 *   (`facilitySchema` still range-checks it).
 * - WITH `sourceOrigins` (`sourceOrigins[newIndex] = oldIndex`, `null` for an
 *   added row) every carried ref at old index k is remapped to
 *   `sourceOrigins.indexOf(k)`; -1 means its source was removed (409).
 *   `sourceOrigins` is trusted, admin-authenticated input (the form action
 *   runs `assertAdminSession`) and is NOT cross-checked against urls, so a url
 *   correction can be saved together with a reorder. It is only validated for
 *   shape (length, integer range, no repeats): otherwise 400.
 * - WITHOUT it, any ambiguity refuses with a 409. A carried ref at index k
 *   passes only if `merged.sources[k]` has the same url as
 *   `existing.sources[k]` AND either that url occurs exactly once in each
 *   array or the two source objects at k are deep-equal. The fast path
 *   (nothing to check) applies only when the two `sources` arrays are
 *   deep-equal. Identity here is the url: a unique-url source whose label,
 *   kind or publisher changed at the same index counts as the same source
 *   refreshed, so its carried citations stay.
 * - A doc whose shape cannot be walked is a 400, not left for later checks.
 */
export type ReconcileResult =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; status: 400 | 409; citing: string[]; error: string };

/**
 * `"parties.ownerEntity[1].sourceIndex"` -> `["parties", "ownerEntity", 1, "sourceIndex"]`:
 * the zod-style issue path the admin form's field map expects.
 */
export function refPathToIssuePath(path: string): (string | number)[] {
  return path.split(".").flatMap((part) => {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) return [part];
    const idx = [...m[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
    return [m[1], ...idx];
  });
}

const MOVED_ERROR = "A carried citation points at a source that moved or was removed";

function sourceList(doc: Record<string, unknown>): unknown[] | null {
  return Array.isArray(doc.sources) ? doc.sources : null;
}

function urlOf(source: unknown): string | undefined {
  return typeof source === "object" && source !== null && typeof (source as { url?: unknown }).url === "string"
    ? (source as { url: string }).url
    : undefined;
}

function validOrigins(origins: readonly (number | null)[], oldLen: number, newLen: number): boolean {
  if (origins.length !== newLen) return false;
  const seen = new Set<number>();
  for (const o of origins) {
    if (o === null) continue;
    if (!Number.isInteger(o) || o < 0 || o >= oldLen || seen.has(o)) return false;
    seen.add(o);
  }
  return true;
}

export function reconcileSourceIndices(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  merged: Record<string, unknown>,
  sourceOrigins?: readonly (number | null)[]
): ReconcileResult {
  const oldSources = sourceList(existing);
  const newSources = sourceList(merged);
  // No usable `sources` on either side: facilitySchema rejects that itself.
  if (!oldSources || !newSources) return { ok: true, doc: merged };
  if (sourceOrigins !== undefined && !validOrigins(sourceOrigins, oldSources.length, newSources.length)) {
    return { ok: false, status: 400, citing: [], error: "Invalid sourceOrigins" };
  }

  try {
    if (sourceOrigins === undefined && canonicalStringify(oldSources) === canonicalStringify(newSources)) {
      return { ok: true, doc: merged };
    }
    const stated = new Set(sourceIndexRefs(patch as SourceIndexCarrier).map((r) => r.path));
    const carried = sourceIndexRefs(merged as SourceIndexCarrier).filter(
      (r) => typeof r.index === "number" && !stated.has(r.path)
    );

    if (sourceOrigins === undefined) {
      const oldUrls = oldSources.map(urlOf);
      const newUrls = newSources.map(urlOf);
      const count = (urls: (string | undefined)[], u: string) => urls.filter((x) => x === u).length;
      const moved = carried
        .filter((r) => {
          const url = oldUrls[r.index];
          if (url === undefined || newUrls[r.index] !== url) return true;
          const unique = count(oldUrls, url) === 1 && count(newUrls, url) === 1;
          const identical =
            canonicalStringify(oldSources[r.index]) === canonicalStringify(newSources[r.index]);
          return !(unique || identical);
        })
        .map((r) => r.path);
      if (moved.length > 0) return { ok: false, status: 409, citing: moved.sort(), error: MOVED_ERROR };
      return { ok: true, doc: merged };
    }

    const removed = carried.filter((r) => sourceOrigins.indexOf(r.index) === -1).map((r) => r.path);
    if (removed.length > 0) return { ok: false, status: 409, citing: removed.sort(), error: MOVED_ERROR };
    const carriedPaths = new Set(carried.map((r) => r.path));
    return {
      ok: true,
      doc: remapSourceIndices(merged as SourceIndexCarrier & Record<string, unknown>, (path, index) =>
        carriedPaths.has(path) ? sourceOrigins.indexOf(index) : index
      ),
    };
  } catch {
    // A doc or patch whose shape cannot be walked (non-array where an array
    // belongs, etc.).
    return { ok: false, status: 400, citing: [], error: "Invalid facility" };
  }
}
