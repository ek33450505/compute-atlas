/**
 * SSRF-safe body-reading fetcher for the (untrusted, model-proposed)
 * candidate-source verification path.
 *
 * `probeUrl` in check-sources.ts is deliberately body-free (classification
 * only) and its contract is unchanged by this file. This fetcher exists
 * because the verification gate (Task 5) needs the actual page text to hand
 * to a local model — which means it carries a stricter guard than a
 * status-only probe: every hop of a redirect chain is re-validated against
 * the SSRF guard BEFORE the connection is made, not just the URL the caller
 * originally passed in. A first-hop-only check is the classic SSRF bypass:
 * a public URL that 302s to an internal address would otherwise sail
 * straight through.
 *
 * Also enforces a response-size cap and a content-type allowlist (never
 * reading an unbounded body before the cap is checked), and strips the body
 * to plain text with a dependency-free regex extractor. Task 5's mechanical
 * quote-matching compares model output against this extractor's output, so
 * entity decoding and whitespace collapsing here directly determine whether
 * a genuine verbatim quote validates.
 */
import { BROWSER_HEADERS, isBlockedHost, isHttpUrl, resolvesToBlockedAddress, type ResolveDeps } from "./net-guard";

/** Hard cap on hops followed before giving up — bounds both latency and the
 * SSRF re-validation loop below. */
export const MAX_REDIRECTS = 5;

/** Hard cap on response body size read into memory. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Only these page types are ever handed to the verification model —
 * anything else (PDFs, images, JSON APIs, ...) is rejected before any body
 * is read. */
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain"];

/** Default per-attempt timeout, matching check-sources.ts's own default. */
const DEFAULT_TIMEOUT_MS = 10_000;

export type FetchPageTextResult =
  | {
      ok: true;
      text: string;
      finalUrl: string;
      httpStatus: number;
      /**
       * The base content-type actually served (one of ALLOWED_CONTENT_TYPES).
       * Optional (not just new-and-unused) because several existing test
       * files in this directory construct `FetchPageTextResult` literals by
       * hand without it — making it required broke those call sites'
       * type-checking even though they never read the field.
       */
      contentType?: string;
      /**
       * The unstripped response body, present only when `contentType` is
       * `"text/html"`. Additive field for `lib/url-triage.ts` (Unit 2's
       * lead-triage caller — the first consumer of this module outside
       * scripts/discovery/), which needs the real `<title>` tag rather than
       * the flattened `text` (tags are already stripped there, so a
       * `<title>` can't be distinguished from surrounding body text once
       * `htmlToText` has run). Every existing caller in this directory reads
       * only `.text`/`.finalUrl`/`.httpStatus`, so this is backward
       * compatible; still bounded by the same MAX_RESPONSE_BYTES cap as
       * `text` since both derive from the one already-capped `rawBody` read.
       */
      rawHtml?: string;
    }
  | {
      ok: false;
      reason: "blocked" | "too_large" | "bad_content_type" | "http_error" | "network_error" | "redirect_limit";
      httpStatus?: number;
      /** Only set for reason "network_error" — the underlying thrown error's
       * `.code` (e.g. "ENOTFOUND", "ECONNRESET", "UND_ERR_SOCKET") if present,
       * else its `.cause?.code` (Node's fetch wraps the real errno in
       * `TypeError: fetch failed`'s `.cause`), else undefined. Surfaced so a
       * caller-side collapse (many "network_error"s in a row) is diagnosable
       * from the log instead of being an opaque, indistinguishable blob — see
       * the file-level incident note below `MAX_REDIRECTS`. */
      errorCode?: string;
      /** Only set for reason "network_error" — `String(err)` (or
       * `.cause`'s if present), truncated. Human-readable companion to
       * `errorCode`, which is sometimes absent (e.g. AbortError has no
       * `.code`). */
      errorMessage?: string;
    };

/** Extracts a diagnosable {errorCode, errorMessage} pair from a thrown fetch
 * error without ever throwing itself. Node's `fetch()` (undici) wraps the
 * real errno in `TypeError: fetch failed`'s `.cause` — e.g. `err.code` is
 * undefined but `err.cause.code` is `"ECONNREFUSED"` — so both levels are
 * checked, preferring the cause when present since it's the more specific
 * signal. An AbortError (per-attempt timeout firing) has neither `.code` nor
 * a `.cause`, so it falls through to just its message/name. */
function describeNetworkError(err: unknown): { errorCode?: string; errorMessage?: string } {
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

  const top = asRecord(err);
  const cause = asRecord(top?.cause);

  const code = (typeof cause?.code === "string" && cause.code) || (typeof top?.code === "string" && top.code) || undefined;

  const rawMessage = (cause && String((cause as { message?: unknown }).message ?? cause)) || String(err);
  const errorMessage = rawMessage.slice(0, 300);

  return { errorCode: code, errorMessage };
}

export interface FetchPageTextDeps {
  fetchImpl: typeof fetch;
  /** Per-attempt timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /**
   * Wall-clock budget in ms across the WHOLE redirect chain (the initial
   * attempt plus every hop), not just a single attempt. `timeoutMs` resets
   * on each iteration of the hop loop, so without this a malicious redirect
   * chain can hold the caller alive for roughly `(MAX_REDIRECTS + 1) *
   * timeoutMs` — six attempts at the default 10s timeout is ~60s.
   *
   * Optional and `undefined` by default so existing scripts/discovery/
   * callers (curated source URLs the operator chose; no wall-clock concern)
   * see NO behavior change — this file's own timeout budget is unchanged
   * unless a caller opts in. `lib/url-triage.ts` (untrusted, anonymous
   * public input, run inside a serverless request) passes an explicit
   * budget.
   */
  totalTimeoutMs?: number;
  /** Injectable DNS resolvers, threaded through to `resolvesToBlockedAddress`
   * so tests never touch real DNS. Production callers omit this and get the
   * real `node:dns/promises` resolvers. */
  resolveDeps?: ResolveDeps;
}

// --- SSRF pre-connection guard --------------------------------------------

/** Validates a URL is safe to connect to: http(s) scheme, not a blocked
 * literal/hostname, and does not resolve (via DNS) to a blocked address.
 * Called before EVERY connection attempt, including each redirect hop. */
async function isUnsafeToConnect(url: string, resolveDeps?: ResolveDeps): Promise<boolean> {
  if (!isHttpUrl(url)) return true;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return true;
  }

  if (isBlockedHost(hostname)) return true;
  return resolvesToBlockedAddress(hostname, resolveDeps);
}

// --- bounded body read ------------------------------------------------------

/**
 * Reads `res`'s body incrementally, aborting the moment the cumulative byte
 * count exceeds `maxBytes`. Never buffers the full body before checking the
 * cap — returns null the instant the cap is crossed, cancelling the
 * underlying stream rather than continuing to drain it.
 *
 * Returns the raw bytes, not a decoded string — a PDF caller needs the bytes
 * verbatim (writing them to disk for `pdftotext`); callers that want text
 * decode with `.toString("utf-8")` themselves.
 */
async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) {
    // Reached only for a genuinely body-less response (204 No Content, 304
    // Not Modified) or a minimal test double — never for a 200, even one
    // with Content-Length: 0, which still exposes a real ReadableStream.
    // Safe: `res.text()` on a body-less response resolves instantly to "",
    // far under `maxBytes`.
    const text = await res.text();
    const buf = Buffer.from(text, "utf-8");
    return buf.byteLength > maxBytes ? null : buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

// --- HTML -> plain text (dependency-free) ----------------------------------

// `<\/\1\b[^>]*>` not `<\/\1>`: HTML parsers tolerate whitespace AND stray junk
// inside an end tag, so `</script >` and even `</script\t\n bar>` are treated as
// end tags while a strict `</script>` misses them — the
// script body then survives into the "plain text" and is fed to the model as if
// it were prose. Flagged by CodeQL (js/bad-tag-filter) on the bench's copy of
// this regex, PR #158; fixed in both so the two stay in step.
const SCRIPT_OR_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

/** The common named entities this dependency-free extractor decodes. Decimal
 * numeric entities (`&#NNN;`) are handled separately below; hex numeric
 * entities (`&#xNNN;`) are out of scope for v1. */
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

/**
 * Strips HTML down to plain text: drops `<script>`/`<style>` elements
 * (including their contents — never leak JS/CSS source into the text a
 * model reasons over), strips all remaining tags, decodes the common HTML
 * entities, and collapses whitespace runs. Order matters: tags are stripped
 * BEFORE entities are decoded, so a literal, escaped "&lt;" in page prose
 * can never be mistaken for a real tag delimiter.
 */
export function htmlToText(html: string): string {
  const withoutScriptsAndStyles = html.replace(SCRIPT_OR_STYLE_RE, " ");
  const withoutTags = withoutScriptsAndStyles.replace(TAG_RE, " ");
  const decoded = decodeEntities(withoutTags);
  return decoded.replace(WHITESPACE_RE, " ").trim();
}

// --- content-type allowlist -------------------------------------------------

function baseContentType(header: string | null): string | null {
  if (!header) return null;
  return header.split(";")[0].trim().toLowerCase();
}

// --- guarded body fetch (shared core) ---------------------------------------

/** Options for {@link fetchGuardedBody}: which base content-types are
 * accepted (checked with the same charset-stripping as `fetchPageText`) and
 * the response-size cap. `maxBytes` defaults to `MAX_RESPONSE_BYTES` — a PDF
 * caller passes a larger cap (documents legitimately exceed 2 MB). */
export interface GuardedBodyOptions {
  allowedContentTypes: readonly string[];
  maxBytes?: number;
}

export type GuardedBodyResult =
  | { ok: true; bytes: Buffer; contentType: string; finalUrl: string; httpStatus: number }
  | {
      ok: false;
      reason: "blocked" | "too_large" | "bad_content_type" | "http_error" | "network_error" | "redirect_limit";
      httpStatus?: number;
      errorCode?: string;
      errorMessage?: string;
    };

/**
 * The guarded fetch core shared by `fetchPageText` (HTML/plain-text) and the
 * PDF fetcher in `fetch-pdf-text.ts`: per-hop SSRF re-validation, redirect
 * and wall-clock budgets, a content-type allowlist, and a size-capped,
 * never-fully-buffered-before-checked body read. See the file doc-comment
 * for why per-hop (not first-hop-only) re-validation is load-bearing.
 *
 * Returns raw bytes, not decoded text — callers that want HTML/plain text
 * decode with `.toString("utf-8")`; a PDF caller writes the bytes to disk
 * unchanged.
 */
export async function fetchGuardedBody(
  url: string,
  deps: FetchPageTextDeps,
  options: GuardedBodyOptions,
): Promise<GuardedBodyResult> {
  const { fetchImpl, resolveDeps } = deps;
  const { allowedContentTypes } = options;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Wall-clock deadline across the WHOLE hop loop — see FetchPageTextDeps's
  // `totalTimeoutMs` doc comment. `undefined` (no budget passed) yields
  // `Infinity` here, so the remaining-budget checks below are always a no-op
  // for callers that don't opt in, preserving today's per-hop-only behavior
  // exactly.
  const deadline = deps.totalTimeoutMs !== undefined ? Date.now() + deps.totalTimeoutMs : Infinity;

  let currentUrl = url;
  let hops = 0;

  for (;;) {
    // Checked before EVERY attempt, including each redirect hop — the whole
    // point is a chain of redirects can't outlast this budget by resetting
    // a per-hop timer on each iteration.
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return {
        ok: false,
        reason: "network_error",
        errorMessage: "Total fetch time budget exceeded across redirect hops",
      };
    }

    if (await isUnsafeToConnect(currentUrl, resolveDeps)) {
      return { ok: false, reason: "blocked" };
    }

    // Armed for the WHOLE attempt — the header fetch AND the body read — and
    // cleared exactly once, in the `finally` below, however this attempt
    // concludes (success, a rejected redirect, an early-return failure
    // reason, or the redirect `continue`). This is deliberately unlike
    // `probeUrl` in check-sources.ts, which clears its timer the moment
    // headers arrive: that's correct there because `probeUrl` never reads a
    // body. This function does, so a timer that stops bounding anything
    // after headers arrive would let a body that stalls mid-stream (a
    // slow-loris response) hang forever — the exact failure this guard
    // exists to prevent.
    //
    // Clamped to whatever total budget remains so the last hop before the
    // deadline can't itself overshoot it (e.g. a 10s per-attempt timeout
    // with only 2s of total budget left waits at most 2s, not 10).
    const attemptTimeoutMs = Math.min(timeoutMs, remainingMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: BROWSER_HEADERS,
        });
      } catch (err) {
        return { ok: false, reason: "network_error", ...describeNetworkError(err) };
      }

      if (res.status >= 300 && res.status < 400) {
        hops++;
        if (hops > MAX_REDIRECTS) {
          return { ok: false, reason: "redirect_limit" };
        }
        const location = res.headers.get("location");
        if (!location) {
          return { ok: false, reason: "http_error", httpStatus: res.status };
        }
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          return { ok: false, reason: "http_error", httpStatus: res.status };
        }
        // Loop back to the top: the new currentUrl is re-validated by
        // isUnsafeToConnect before any connection is attempted. This is the
        // load-bearing property of this function — see the file doc-comment.
        continue;
      }

      if (!res.ok) {
        return { ok: false, reason: "http_error", httpStatus: res.status };
      }

      const contentType = baseContentType(res.headers.get("content-type"));
      if (!contentType || !allowedContentTypes.includes(contentType)) {
        return { ok: false, reason: "bad_content_type", httpStatus: res.status };
      }

      const declaredLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        return { ok: false, reason: "too_large", httpStatus: res.status };
      }

      let bytes: Buffer | null;
      try {
        bytes = await readBodyWithCap(res, maxBytes);
      } catch (err) {
        // The timer above stays armed through this call, so a body that
        // sends headers immediately and then stalls mid-stream lands here
        // as an abort — not an unbounded hang and not an uncaught throw.
        return { ok: false, reason: "network_error", ...describeNetworkError(err) };
      }
      if (bytes === null) {
        return { ok: false, reason: "too_large", httpStatus: res.status };
      }

      return { ok: true, bytes, contentType, finalUrl: currentUrl, httpStatus: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- main entry point --------------------------------------------------------

/**
 * Fetches `url` and returns its body as plain text, or a discriminated
 * failure reason. SSRF-safe (per-hop re-validated), size-capped, and
 * content-type-restricted — a thin wrapper over the shared
 * {@link fetchGuardedBody} core; see the file doc-comment.
 */
export async function fetchPageText(url: string, deps: FetchPageTextDeps): Promise<FetchPageTextResult> {
  const maxBytes = MAX_RESPONSE_BYTES;
  const result = await fetchGuardedBody(url, deps, { allowedContentTypes: ALLOWED_CONTENT_TYPES, maxBytes });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
      ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
    };
  }

  const rawBody = result.bytes.toString("utf-8");
  return {
    ok: true,
    text: htmlToText(rawBody),
    finalUrl: result.finalUrl,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    ...(result.contentType === "text/html" ? { rawHtml: rawBody } : {}),
  };
}
