/**
 * Pure source-URL helper shared by the discovery tools (no imports: it must
 * stay cheap to load from any script without dragging in another tool's
 * dependency graph).
 */

/**
 * Normalizes a source URL for set-membership comparison. Lowercases the scheme
 * and host, strips a trailing `#fragment`, and strips one trailing slash from a
 * non-root path — but leaves the query string byte-for-byte, since a query
 * string can be the whole identity of a specific cited record (a cited record can be identified by it alone).
 * Falls back to a best-effort string normalization for a value `new URL()`
 * cannot parse, so a malformed source URL still participates in comparisons
 * (as itself) rather than silently dropping out of every intersection.
 */
export function normalizeSourceUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl.trim().replace(/#.*$/, "").replace(/([^/])\/$/, "$1").toLowerCase();
  }
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}
