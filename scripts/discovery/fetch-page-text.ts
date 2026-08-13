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
  | { ok: true; text: string; finalUrl: string; httpStatus: number }
  | {
      ok: false;
      reason: "blocked" | "too_large" | "bad_content_type" | "http_error" | "network_error" | "redirect_limit";
      httpStatus?: number;
    };

export interface FetchPageTextDeps {
  fetchImpl: typeof fetch;
  /** Per-attempt timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
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
 */
async function readBodyWithCap(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) {
    // Reached only for a genuinely body-less response (204 No Content, 304
    // Not Modified) or a minimal test double — never for a 200, even one
    // with Content-Length: 0, which still exposes a real ReadableStream.
    // Safe: `res.text()` on a body-less response resolves instantly to "",
    // far under `maxBytes`.
    const text = await res.text();
    return Buffer.byteLength(text, "utf-8") > maxBytes ? null : text;
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

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
}

// --- HTML -> plain text (dependency-free) ----------------------------------

const SCRIPT_OR_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
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

// --- main entry point --------------------------------------------------------

/**
 * Fetches `url` and returns its body as plain text, or a discriminated
 * failure reason. SSRF-safe (per-hop re-validated), size-capped, and
 * content-type-restricted — see the file doc-comment.
 */
export async function fetchPageText(url: string, deps: FetchPageTextDeps): Promise<FetchPageTextResult> {
  const { fetchImpl, resolveDeps } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let currentUrl = url;
  let hops = 0;

  for (;;) {
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: BROWSER_HEADERS,
        });
      } catch {
        return { ok: false, reason: "network_error" };
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
      if (!contentType || !ALLOWED_CONTENT_TYPES.includes(contentType)) {
        return { ok: false, reason: "bad_content_type", httpStatus: res.status };
      }

      const declaredLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        return { ok: false, reason: "too_large", httpStatus: res.status };
      }

      let rawBody: string | null;
      try {
        rawBody = await readBodyWithCap(res, MAX_RESPONSE_BYTES);
      } catch {
        // The timer above stays armed through this call, so a body that
        // sends headers immediately and then stalls mid-stream lands here
        // as an abort — not an unbounded hang and not an uncaught throw.
        return { ok: false, reason: "network_error" };
      }
      if (rawBody === null) {
        return { ok: false, reason: "too_large", httpStatus: res.status };
      }

      return { ok: true, text: htmlToText(rawBody), finalUrl: currentUrl, httpStatus: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
}
