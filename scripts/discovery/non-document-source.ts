/**
 * Predicate shared by `extract-fields.ts` and `verify-fields.ts` (issue
 * #230): mechanically recognizes a cited `Source` that structurally cannot
 * be read as a document — an interactive map endpoint, a GIS feature
 * service, or a geocoder lookup — rather than an article, filing, or PDF.
 * Neither of those two tools ever filtered by source kind before this
 * existed: both iterated `facility.sources` and tried to `fetchSourceText`
 * every entry unconditionally. Measured on a full sweep: 624 of 4,401 cited
 * source entries (14.4%) are one of these non-document shapes. They are
 * fetched on every sweep, always fail (an ArcGIS `FeatureServer` endpoint
 * returns JSON or an HTML map-viewer shell, never prose; Nominatim returns a
 * geocoder JSON payload), and land in the same `unreachable` bucket as a
 * genuine bot-wall or dead link — indistinguishable, in the output, from "we
 * tried to check this fact and could not." One ArcGIS `FeatureServer` URL
 * alone is cited on 307 facilities (it is the documented source for their
 * `energy.utility`) and single-handedly accounted for 131 of 134 "thin page"
 * triples in a full `verify-fields.ts` sweep (see that file's WAYBACK
 * FALLBACK section).
 *
 * THIS IS A FETCH-ROUTING DECISION, NOT A DATA-QUALITY ONE. These citations
 * are REAL, verified provenance — the ArcGIS URL above genuinely is where
 * `energy.utility` was sourced from, a human just can't get there via
 * `fetchSourceText`'s document-reading pipeline (HTML prose extraction / PDF
 * text extraction). Nothing in this module deletes, rewrites, or
 * deprioritizes a citation; it only tells the two callers "don't bother
 * fetching this one as a document," identically to how a `.pdf`-extension
 * check already routes a different shape of URL to a different fetch path.
 *
 * Deliberately pure and synchronous — no network access, no `Facility`
 * dependency, just a URL/kind classification — so both callers can call it
 * before ever touching `fetchSourceText` or incrementing any fetch-attempt
 * counter, and so it is trivially unit-testable without any of the
 * fetch-mocking machinery `extract-fields.test.ts`/`verify-fields.test.ts`
 * otherwise need.
 */

/** Minimal shape this predicate needs — deliberately narrower than the full
 * `Source` type (`lib/schema.ts`) so callers never need to import that type
 * just to call this function, and so a test fixture can supply exactly the
 * two fields that matter. */
export interface NonDocumentSourceCandidate {
  url: string;
  kind?: string;
}

/**
 * True when `source` is structurally unreadable as a document and should be
 * skipped BEFORE any fetch is attempted. Two independent signals, either one
 * sufficient:
 *
 * 1. `kind === "osm"` — this project's own curation-time tag for an
 *    OpenStreetMap-derived citation (see `sourceKindEnum`, `lib/schema.ts`).
 *    A curator who tagged a source `osm` already asserted it is a map/geo
 *    reference, not prose to read.
 * 2. The URL itself matches one of a small set of well-known non-document
 *    shapes, checked case-insensitively against the parsed URL (never a raw
 *    substring match against the full string — see the FALSE POSITIVE note
 *    below for why that distinction matters):
 *      - `/arcgis/rest/services/` anywhere in the path — an Esri ArcGIS REST
 *        API endpoint, present on many county/state GIS hosts, not just
 *        arcgis.com.
 *      - `/mapserver/` or `/featureserver/` anywhere in the path — the two
 *        ArcGIS REST service TYPES that actually serve geodata (as opposed
 *        to, say, a `GPServer`), reachable even without the
 *        `/arcgis/rest/services/` path segment on some hosts' shortened
 *        routes.
 *      - `arcgis.com/home/item.html` — Esri's own hosted "item details"
 *        viewer page, an interactive map/gallery entry, not an article.
 *      - `nominatim.openstreetmap.org` as the hostname — the OSM project's
 *        public geocoder; every response is a JSON/XML coordinate lookup.
 *      - a `f=json` query parameter — ArcGIS REST's own "give me JSON, not
 *        the HTML viewer" format switch; present on plenty of ArcGIS URLs
 *        that don't otherwise match the path patterns above (e.g. a
 *        `/query` endpoint).
 *
 * FALSE POSITIVE THIS FUNCTION MUST NEVER PRODUCE: an earlier draft of this
 * predicate matched on a bare `/search/` path substring, intending to catch
 * geocoder-style "search" endpoints. It over-matched two real, perfectly
 * readable TDLR (Texas Department of Licensing and Regulation) permit-record
 * pages — `https://www.tdlr.texas.gov/TABS/Search/Project/TABS2025023484`
 * and `https://www.tdlr.texas.gov/TABS/Search/Print/TABS2023019972` — whose
 * path happens to contain the word "Search" as part of that site's own
 * routing, not because they are a search/geocoder endpoint. Both are
 * asserted as NON-matches in `non-document-source.test.ts`; the patterns
 * above are deliberately specific enough (`/arcgis/rest/services/`,
 * `/mapserver/`, `/featureserver/`, a real hostname, a real query parameter)
 * that neither TDLR URL matches any of them.
 *
 * An unparseable `url` (should not occur — `sourceSchema.url` is validated
 * at intake — but this function must never assume that) returns `false`
 * rather than throwing: fetch it and let the existing failure path
 * (`fetchSourceText` returning `{ ok: false }`) handle it exactly as before
 * this predicate existed, never a NEW failure mode introduced here.
 */
export function isNonDocumentSource(source: NonDocumentSourceCandidate): boolean {
  if (source.kind === "osm") return true;

  let parsed: URL;
  try {
    parsed = new URL(source.url);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (path.includes("/arcgis/rest/services/")) return true;
  if (path.includes("/mapserver/")) return true;
  if (path.includes("/featureserver/")) return true;
  if (host.endsWith("arcgis.com") && path.includes("/home/item.html")) return true;
  if (host.endsWith("nominatim.openstreetmap.org")) return true;

  const fParam = parsed.searchParams.get("f");
  if (fParam !== null && fParam.toLowerCase() === "json") return true;

  return false;
}
