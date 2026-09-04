/**
 * Wayback Machine availability lookup, shared by BOTH the discovery lane
 * (`verify-source.ts`) and the verification lane (`verify-fields.ts`). This
 * module only answers "is there a snapshot, and where" — the *decision*
 * about whether a snapshot is usable (whether to fall back to it, how to
 * weight its result, what outcome an unreadable snapshot produces)
 * deliberately stays in each caller.
 */

// --- Wayback fallback ----------------------------------------------------

const WAYBACK_AVAILABILITY_URL = "https://archive.org/wayback/available";

interface WaybackAvailabilityResponse {
  archived_snapshots?: {
    closest?: {
      available?: boolean;
      url?: string;
    };
  };
}

/** Small JSON API on a third-party host (archive.org), on the fallback path
 * only. Bounded generously relative to its typical response time, but still
 * bounded: an unresponsive archive.org is not OUR verification machinery
 * failing, so a timeout here is deliberately treated exactly like "no
 * snapshot available" (see `findWaybackSnapshotUrl`'s doc-comment), never
 * escalated into its own failure mode or mapped to "unavailable". */
const WAYBACK_TIMEOUT_MS = 15_000;

/** Hard cap on the availability API's response body, enforced regardless of
 * (never trusting solely) the `Content-Length` header — see
 * `readCappedText`. The real payload is a few hundred bytes at most, so
 * 64 KB is already three orders of magnitude of headroom: if this is ever
 * hit, something is wrong, not merely large. */
export const WAYBACK_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Reads `res`'s body as text, capped at `maxBytes`. Checks `Content-Length`
 * first for a cheap early bail that avoids reading the body at all, but
 * never trusts that header alone — the actual bytes received are measured
 * too, so a missing or lying `Content-Length` can't defeat the cap. Kept
 * local rather than reusing `fetch-page-text.ts`'s `readBodyWithCap`: that
 * helper is module-private there, and this caller's budget (64 KB, a fixed
 * trusted host) doesn't need its incremental-stream machinery.
 */
async function readCappedText(res: Response, maxBytes: number): Promise<string | null> {
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;

  const text = await res.text();
  return Buffer.byteLength(text, "utf-8") > maxBytes ? null : text;
}

/**
 * Queries the Wayback Machine's availability API for a snapshot of `url`.
 * Returns the snapshot's own fetchable URL, or null if none is available —
 * including on any network/parse/timeout/oversized-response error, all
 * treated identically to "no snapshot" rather than surfaced as their own
 * failure mode. Bounded by `WAYBACK_TIMEOUT_MS` (covering both the request
 * and the read) and `WAYBACK_MAX_RESPONSE_BYTES` (see that constant's
 * doc-comment), so neither an unresponsive nor a misbehaving archive.org can
 * hang or balloon this call.
 *
 * Like every other fetch on this path, this call pins `redirect: "manual"`;
 * a 3xx response fails the `!res.ok` check below and is treated as "no
 * snapshot", same as any other non-2xx status. The snapshot URL this
 * returns is never read through this raw `fetchImpl` — it's re-fetched
 * through the fully SSRF-guarded `fetchPageTextImpl` before any content is
 * read from it.
 */
export async function findWaybackSnapshotUrl(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAYBACK_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${WAYBACK_AVAILABILITY_URL}?url=${encodeURIComponent(url)}`, {
        signal: controller.signal,
        redirect: "manual",
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;

    let text: string | null;
    try {
      text = await readCappedText(res, WAYBACK_MAX_RESPONSE_BYTES);
    } catch {
      return null;
    }
    if (text === null) return null;

    let parsed: WaybackAvailabilityResponse;
    try {
      parsed = JSON.parse(text) as WaybackAvailabilityResponse;
    } catch {
      return null;
    }

    const closest = parsed.archived_snapshots?.closest;
    if (!closest?.available || !closest.url) return null;
    return closest.url;
  } finally {
    clearTimeout(timer);
  }
}
