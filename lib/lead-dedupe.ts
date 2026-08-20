/**
 * Submit-time duplicate check for `POST /api/leads`: does any live facility
 * already cite this URL as a source? Reads `getAllFacilities()` (the
 * existing `withJsonFallback`-wrapped, cached facility loader — ~1034
 * records) and filters in JS rather than writing new jsonb SQL, since a full
 * scan at this scale is trivially fast.
 */
import { getAllFacilities } from "@/lib/data";

/**
 * Normalizes a URL for loose duplicate comparison: lowercases the host,
 * strips a leading `www.` and a trailing `/` from the path, and drops the
 * fragment. The query string is deliberately KEPT — it's often load-bearing
 * on county permit-portal URLs (e.g. `?docId=...`), unlike a fragment, which
 * never identifies distinct server-side content. Returns null for an
 * unparseable URL rather than throwing.
 */
export function normalizeUrlForDedupe(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${host}${pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * Returns the ids of live facilities whose `sources[].url` matches `url`
 * under `normalizeUrlForDedupe`. Never throws — any failure (a malformed
 * URL, a facility-loader error) yields `[]` rather than blocking triage.
 */
export async function findFacilitiesCitingUrl(url: string): Promise<string[]> {
  try {
    const normalizedTarget = normalizeUrlForDedupe(url);
    if (!normalizedTarget) return [];

    const facilities = await getAllFacilities();
    const matches: string[] = [];
    for (const facility of facilities) {
      const cited = facility.sources.some(
        (source) => normalizeUrlForDedupe(source.url) === normalizedTarget
      );
      if (cited) matches.push(facility.id);
    }
    return matches;
  } catch {
    return [];
  }
}
