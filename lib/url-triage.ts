/**
 * Submit-time mechanical inspection of a lead's URL, run once by
 * `POST /api/leads` AFTER the lead row is already durably saved (see that
 * route's doc comment — triage must never gate or delay the 201).
 *
 * This is the first caller of `scripts/discovery/fetch-page-text.ts` from
 * outside `scripts/discovery/` — deliberately: that module already owns the
 * SSRF pre-connection guard (blocked hosts, DNS re-resolution per redirect
 * hop, redirect cap, response-size cap), and a lead's `url` is untrusted,
 * anonymous public input. Never call bare `fetch()` on it — that would
 * reopen the exact SSRF hole `fetch-page-text.ts` exists to close. The
 * import surface here is `fetchPageText` and its types, plus the additive
 * `contentType`/`rawHtml` fields added to `FetchPageTextResult`'s ok branch
 * (see that file's doc comment) so this module can read the real `<title>`
 * tag instead of `fetchPageText`'s already-tag-stripped `text`, which cannot
 * distinguish a title from surrounding body text once flattened.
 */
import { fetchPageText, type FetchPageTextDeps, type FetchPageTextResult } from "@/scripts/discovery/fetch-page-text";
import type { LeadTriage } from "@/lib/leads";

/** This request runs inside a user-facing POST. Per-attempt timeout is
 * TRIAGE_TIMEOUT_MS (5s), but that resets on every redirect hop — without a
 * total budget, `fetchPageText`'s own worst case is roughly
 * `(MAX_REDIRECTS + 1) * TRIAGE_TIMEOUT_MS` ≈ 30s, not "bounded well under
 * any reasonable serverless function timeout" as this comment previously
 * (and incorrectly) claimed. TRIAGE_TOTAL_TIMEOUT_MS below is the real bound. */
const TRIAGE_TIMEOUT_MS = 5000;

/** Total wall-clock budget in ms across the WHOLE redirect chain, threaded
 * to `fetchPageText`'s `totalTimeoutMs` — see that field's doc comment. 10s
 * is enough for a couple of legitimate redirects while staying far short of
 * a 30s worst case, and far short of any reasonable serverless function
 * timeout. */
const TRIAGE_TOTAL_TIMEOUT_MS = 10_000;

const MAX_TITLE_LENGTH = 300;
const MAX_ERROR_LENGTH = 300;

const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const WHITESPACE_RE = /\s+/g;

// Mirrors fetch-page-text.ts's own NAMED_ENTITY_RE/NAMED_ENTITIES — kept as a
// small standalone copy rather than exported from that file, since a title
// decoder is a lead-triage concern, not part of the shared SSRF fetcher.
const NAMED_ENTITY_RE = /&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g;
const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(input: string): string {
  const named = input.replace(NAMED_ENTITY_RE, (match) => NAMED_ENTITIES[match]);
  return named.replace(/&#(\d+);/g, (match, code: string) => {
    const codepoint = Number(code);
    return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : match;
  });
}

/** Extracts, entity-decodes, and whitespace-collapses a page's `<title>`,
 * truncated to 300 chars. Returns undefined when there's no rawHtml (e.g. a
 * text/plain response) or no `<title>` tag, or when it decodes to empty. */
function extractTitle(rawHtml: string | undefined): string | undefined {
  if (!rawHtml) return undefined;
  const match = TITLE_TAG_RE.exec(rawHtml);
  if (!match) return undefined;
  const decoded = decodeEntities(match[1]).replace(WHITESPACE_RE, " ").trim();
  return decoded.length > 0 ? decoded.slice(0, MAX_TITLE_LENGTH) : undefined;
}

/** Human-readable summary of a failed fetchPageText call, for LeadTriage.error. */
function describeFailure(result: Extract<FetchPageTextResult, { ok: false }>): string {
  switch (result.reason) {
    case "blocked":
      return "URL resolves to a blocked or private address";
    case "too_large":
      return "Response exceeded the size cap";
    case "bad_content_type":
      return "Response was not HTML or plain text";
    case "redirect_limit":
      return "Too many redirects";
    case "http_error":
      return result.httpStatus !== undefined ? `HTTP error ${result.httpStatus}` : "HTTP error";
    case "network_error":
      return result.errorMessage ?? result.errorCode ?? "Network error";
    default:
      return "Fetch failed";
  }
}

export interface TriageUrlDeps {
  /** Defaults to the global `fetch`. Tests inject a fake — never hit the real network. */
  fetchImpl?: typeof fetch;
  /** Defaults to 5000ms — see TRIAGE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Defaults to 10_000ms — see TRIAGE_TOTAL_TIMEOUT_MS. Threaded straight
   * through to fetchPageText's `totalTimeoutMs`. */
  totalTimeoutMs?: number;
  /** Injectable DNS resolvers, threaded straight through to fetchPageText's SSRF guard for tests. */
  resolveDeps?: FetchPageTextDeps["resolveDeps"];
}

/**
 * Fetches `url` once through the SSRF-guarded `fetchPageText` and returns a
 * `LeadTriage`. NEVER throws — every failure path (blocked host, timeout,
 * network error, bad content type, or an unexpected exception) collapses to
 * `{ ok: false, error }` so a bad URL can never turn a saved lead into a 500.
 * `duplicateFacilityIds` is left unset here; the caller fills it in via
 * `lib/lead-dedupe.ts`.
 */
export async function triageUrl(url: string, deps: TriageUrlDeps = {}): Promise<LeadTriage> {
  const fetchedAt = new Date().toISOString();
  try {
    const result = await fetchPageText(url, {
      fetchImpl: deps.fetchImpl ?? fetch,
      timeoutMs: deps.timeoutMs ?? TRIAGE_TIMEOUT_MS,
      totalTimeoutMs: deps.totalTimeoutMs ?? TRIAGE_TOTAL_TIMEOUT_MS,
      resolveDeps: deps.resolveDeps,
    });

    if (!result.ok) {
      return {
        fetchedAt,
        ok: false,
        httpStatus: result.httpStatus,
        error: describeFailure(result).slice(0, MAX_ERROR_LENGTH),
      };
    }

    return {
      fetchedAt,
      ok: true,
      httpStatus: result.httpStatus,
      finalUrl: result.finalUrl,
      ...(result.contentType ? { contentType: result.contentType } : {}),
      title: extractTitle(result.rawHtml),
    };
  } catch (err) {
    return { fetchedAt, ok: false, error: String(err).slice(0, MAX_ERROR_LENGTH) };
  }
}
