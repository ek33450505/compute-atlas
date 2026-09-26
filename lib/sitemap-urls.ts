/**
 * Dependency-free leaf module for reading a segmented sitemap over HTTP: an
 * index document (`<sitemapindex>`) listing child sitemaps, each a
 * `<urlset>` of page URLs. Zero `next/*` imports — same rule as
 * `lib/counties.ts`'s header comment: bare `tsx` CLIs (`scripts/indexnow.ts`,
 * and later `scripts/index-census.ts`) need these functions without dragging
 * in the Next.js runtime.
 *
 * One implementation, not two: more than one script needs to walk a sitemap
 * index and collect per-family URL lists, so that logic lives here rather
 * than being copied into each caller.
 *
 * `/sitemap.xml` is a hand-written sitemap index (`app/sitemap.xml/route.ts`)
 * listing nine children at `/sitemaps/<family>.xml`
 * (`app/sitemaps/[family]/route.ts`). Next.js itself has no
 * `<sitemapindex>` support at all — verified against Next 16.3.3: the string
 * appears nowhere in `node_modules/next/dist`, and `generateSitemaps()`
 * produces `/sitemap/<id>.xml` routes instead of augmenting `/sitemap.xml`
 * with an index. The index exists purely because we hand-wrote it.
 */

/** The five predefined XML entities. `&amp;` is unescaped last so `&amp;lt;` survives as `&lt;`. */
export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** True when `xml`'s root element is `<sitemapindex>` rather than `<urlset>`. */
export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/** Every `<loc>` value in `xml`, decoded and trimmed, in document order. */
export function parseLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => decodeXml(m[1].trim()));
}

/**
 * Fetches a sitemap (or sitemap index) document as text. Throws on a non-ok
 * response, naming the status and URL. Message shape
 * (`Sitemap fetch failed: <status> <statusText> (<url>)`) is asserted by
 * `scripts/indexnow.test.ts` — keep it stable.
 */
export async function fetchSitemapXml(url: string): Promise<string> {
  const response = await fetch(url, { headers: { accept: "application/xml" } });
  if (!response.ok) {
    throw new Error(`Sitemap fetch failed: ${response.status} ${response.statusText} (${url})`);
  }
  return response.text();
}

/**
 * Basename of a child sitemap URL, without its `.xml` extension —
 * `https://…/sitemaps/counties.xml` -> `"counties"`. Used only to label
 * errors and group results; it does not validate against
 * `lib/sitemap-families.ts`'s `SITEMAP_FAMILY_IDS`, since a URL read back
 * from a fetched document isn't guaranteed to name one of our own families.
 */
export function familyFromChildUrl(url: string): string {
  const last = url.split("/").pop() ?? url;
  return last.replace(/\.xml$/i, "");
}

export interface SitemapFamilyUrls {
  family: string;
  /**
   * The URL actually FETCHED for this child — rebased onto the origin
   * `indexUrl` was itself fetched from when that differs from the child's
   * own `<loc>` origin. Equal to the child's `<loc>` value when the origins
   * already match (the production case).
   */
  sitemapUrl: string;
  /**
   * Page URLs harvested from inside the child document (its own
   * `<url><loc>` values), returned completely untouched. Never rebased —
   * see the inline comment where these are parsed.
   */
  urls: string[];
}

/**
 * Follows a sitemap INDEX at `indexUrl` and collects every page URL from
 * each of its child `<urlset>` sitemaps, grouped by family.
 *
 * `indexXml`, if passed, is used instead of re-fetching `indexUrl` — a
 * caller that already fetched the document (e.g. to decide via
 * `isSitemapIndex` whether to call this at all) would otherwise cause a
 * redundant production request for the same URL.
 *
 * Children are fetched SEQUENTIALLY, not in parallel — this hits production
 * and there are only nine children today, so there's no throughput reason to
 * parallelize, and sequential keeps a failure attributable to one request.
 *
 * Each child's `<loc>` in the index is an absolute PRODUCTION URL (e.g.
 * `https://www.compute-atlas.com/sitemaps/static.xml`) — correct, since
 * that's what gets submitted to Google. But fetching it verbatim makes this
 * function unusable against any non-production origin: `indexUrl` might be
 * `http://localhost:3999/sitemap.xml` (a local build serving the real
 * index), whose children don't exist yet at the production origin on an
 * unmerged branch. So the FETCH target is rebased onto `indexUrl`'s own
 * origin — the child's path, plus query if any, resolved against that
 * origin (never string-concatenated, never assuming a `/sitemaps/` prefix).
 * When the index and its children already share an origin (the production
 * case) this resolves back to the exact same URL: an intentional no-op.
 *
 * The page URLs harvested from each child (its own `<url><loc>` values, in
 * the returned `urls` array) are NOT rebased — see the inline comment where
 * they're parsed below.
 *
 * Every failure throws loudly, naming the URL or family involved:
 *  - `indexUrl` does not resolve to an index (e.g. it is itself a `<urlset>`)
 *  - the index has zero `<sitemap>` children
 *  - a child sitemap is itself an index (nesting is not supported)
 *  - a child sitemap yields zero `<loc>` entries (a broken child, not a no-op)
 */
export async function collectSitemapUrlsByFamily(
  indexUrl: string,
  indexXml?: string
): Promise<SitemapFamilyUrls[]> {
  const xml = indexXml ?? (await fetchSitemapXml(indexUrl));
  if (!isSitemapIndex(xml)) {
    throw new Error(`${indexUrl} is not a sitemap INDEX (no <sitemapindex> root) — nothing to follow.`);
  }

  const childLocs = parseLocs(xml);
  if (childLocs.length === 0) {
    throw new Error(`${indexUrl} is a sitemap index with zero <sitemap> children — refusing to treat this as a no-op.`);
  }

  // Rebase only the FETCH target onto the origin `indexUrl` was itself
  // fetched from. Resolving the child's path (+ search) against that origin
  // means production stays byte-identical (same origin in, same origin out)
  // while a non-production `indexUrl` follows its children locally instead
  // of leaking out to production.
  const indexOrigin = new URL(indexUrl).origin;

  const results: SitemapFamilyUrls[] = [];
  for (const childLoc of childLocs) {
    const family = familyFromChildUrl(childLoc);
    const childUrl = new URL(childLoc);
    const fetchUrl = new URL(`${childUrl.pathname}${childUrl.search}`, indexOrigin).toString();

    const childXml = await fetchSitemapXml(fetchUrl);
    if (isSitemapIndex(childXml)) {
      throw new Error(
        `${fetchUrl} (family "${family}") is itself a sitemap INDEX — nested sitemap indexes are not supported.`
      );
    }

    // ⚠️ CRITICAL: `urls` are the page URLs harvested from INSIDE the child
    // document (its own <url><loc> values) and are returned completely
    // untouched, exactly as the document states them — NOT rebased to the
    // fetch origin. These are the canonical URLs that get submitted to
    // Google and inspected in Search Console; rewriting them to a
    // local/dev origin would silently make an entire census measure URLs
    // that do not exist.
    const urls = parseLocs(childXml);
    if (urls.length === 0) {
      throw new Error(
        `Child sitemap for family "${family}" (${fetchUrl}) has zero <loc> entries — refusing to treat this as a no-op.`
      );
    }
    results.push({ family, sitemapUrl: fetchUrl, urls });
  }
  return results;
}
