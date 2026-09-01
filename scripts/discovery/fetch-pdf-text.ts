/**
 * PDF-text fetcher for the discovery pipeline's candidate-source
 * verification path.
 *
 * Reuses `fetchGuardedBody` from `fetch-page-text.ts` for the SSRF/redirect/
 * size machinery (per-hop re-validation, redirect + wall-clock budgets, a
 * never-fully-buffered size cap), then hands the downloaded bytes to the
 * local `pdftotext` (poppler) binary for extraction.
 *
 * Deliberately a SEPARATE module from `fetch-page-text.ts`: this file spawns
 * a child process and touches the filesystem (temp dir), which
 * `fetch-page-text.ts` must never do — `lib/url-triage.ts` imports that file
 * into the Next.js serverless bundle, and a `node:child_process`/`node:fs`/
 * `node:os` import there would drag those into that bundle too.
 *
 * `-layout` mode (not raw) is required: raw `pdftotext` splices hyphenated
 * line-break words together (`droughttolerant`, `highdemand`, `onstreet`)
 * and, worse, breaks apart a single logical line like a spec table's
 * `CRITICAL IT LOAD    240MW` into a separate label and value. `-layout`
 * preserves the source's visual line structure, avoiding both. This is why
 * `normalizePdfText` below preserves newlines rather than collapsing all
 * whitespace to single spaces the way `htmlToText` does — collapsing
 * newlines here would re-introduce the exact "label glued to a different
 * line's value" ambiguity `-layout` was chosen to avoid.
 */
import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { fetchGuardedBody, type FetchPageTextDeps } from "./fetch-page-text";

const execFileAsync = promisify(execFileCb);

/** Hard cap on the downloaded PDF's byte size. Sized well above a typical
 * filing (hundreds of KB) but well below the multi-hundred-MB agenda packets
 * that occasionally show up in county-portal PDF links. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB

/** Hard cap on the number of pages handed to `pdftotext` — bounds both
 * latency and memory for the rare pathological (thousand-page) PDF. */
export const PDF_PAGE_LIMIT = 400;

/** Hard cap on how long `pdftotext` is allowed to run before being killed. */
export const PDFTOTEXT_TIMEOUT_MS = 60_000;

/** The first N bytes checked for the `%PDF-` magic number. A Content-Type
 * header is a claim, not evidence — this project has been burned before by
 * servers that lie about what they serve — so the actual bytes are always
 * checked regardless of what the header said. */
const PDF_MAGIC_SCAN_BYTES = 1024;
const PDF_MAGIC = "%PDF-";

export type FetchPdfTextResult =
  | { ok: true; text: string; finalUrl: string; httpStatus: number; contentType: "application/pdf" }
  | {
      ok: false;
      reason:
        | "blocked"
        | "too_large"
        | "bad_content_type"
        | "http_error"
        | "network_error"
        | "redirect_limit"
        | "pdf_extractor_unavailable"
        | "pdf_extract_failed";
      httpStatus?: number;
      errorCode?: string;
      errorMessage?: string;
    };

export interface FetchPdfTextDeps extends FetchPageTextDeps {
  /** Injectable in tests so no test ever spawns a real process. Defaults to
   * the real `child_process.execFile` (promisified). */
  execFileImpl?: typeof execFileAsync;
  /** Injectable in tests so no test ever touches the network. Defaults to
   * the real `fetchGuardedBody`. */
  fetchGuardedBodyImpl?: typeof fetchGuardedBody;
}

/**
 * Normalizes raw `pdftotext -layout` output: form-feed page separators
 * become newlines, each line's interior whitespace runs collapse to a
 * single space (trailing whitespace trimmed), and runs of 3+ blank lines
 * collapse to a single blank line (2 newlines). Newlines themselves are
 * NEVER collapsed away — unlike `htmlToText`'s `\s+ -> " "`, which would
 * destroy the line structure `-layout` exists to preserve (see the file
 * doc-comment's `CRITICAL IT LOAD    240MW` example: collapsing that line's
 * internal run of spaces is fine, collapsing the newline AFTER it into the
 * next line is not — that's how a label gets glued to the wrong value).
 */
export function normalizePdfText(raw: string): string {
  const withoutFormFeeds = raw.replace(/\f/g, "\n");
  const lines = withoutFormFeeds.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trimEnd());
  const collapsedBlankRuns = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return collapsedBlankRuns.trim();
}

function truncate(message: string, maxLen = 500): string {
  return message.length > maxLen ? message.slice(0, maxLen) : message;
}

/** True iff `bytes` contains the `%PDF-` magic number within the first
 * `PDF_MAGIC_SCAN_BYTES` bytes. Real PDFs sometimes carry a few bytes of
 * junk (BOM, whitespace) before the header, so this scans a window rather
 * than requiring an exact offset-0 match. */
function hasPdfMagicBytes(bytes: Buffer): boolean {
  const window = bytes.subarray(0, PDF_MAGIC_SCAN_BYTES).toString("latin1");
  return window.includes(PDF_MAGIC);
}

/**
 * Fetches `url`, verifies it is actually a PDF (magic bytes, not just the
 * declared content-type), and extracts its text with `pdftotext -layout`.
 * SSRF-safe and size-capped via the same guarded core `fetchPageText` uses —
 * see the file doc-comment.
 */
export async function fetchPdfText(url: string, deps: FetchPdfTextDeps): Promise<FetchPdfTextResult> {
  const fetchGuardedBodyFn = deps.fetchGuardedBodyImpl ?? fetchGuardedBody;
  const execFileFn = deps.execFileImpl ?? execFileAsync;

  const fetched = await fetchGuardedBodyFn(url, deps, {
    allowedContentTypes: ["application/pdf"],
    maxBytes: MAX_PDF_BYTES,
  });

  if (!fetched.ok) {
    return {
      ok: false,
      reason: fetched.reason,
      ...(fetched.httpStatus !== undefined ? { httpStatus: fetched.httpStatus } : {}),
      ...(fetched.errorCode !== undefined ? { errorCode: fetched.errorCode } : {}),
      ...(fetched.errorMessage !== undefined ? { errorMessage: fetched.errorMessage } : {}),
    };
  }

  if (!hasPdfMagicBytes(fetched.bytes)) {
    // The content-type header claimed application/pdf but the body isn't
    // one — a lying server, not a real PDF. Same failure reason
    // fetchPageText would give for any other content-type mismatch.
    return { ok: false, reason: "bad_content_type", httpStatus: fetched.httpStatus };
  }

  let tempDir: string | undefined;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ca-pdf-"));
    const pdfPath = path.join(tempDir, "source.pdf");
    await fs.writeFile(pdfPath, fetched.bytes);

    let stdout: string;
    try {
      const result = await execFileFn(
        "pdftotext",
        ["-layout", "-q", "-f", "1", "-l", String(PDF_PAGE_LIMIT), pdfPath, "-"],
        { timeout: PDFTOTEXT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      );
      stdout = result.stdout;
    } catch (err) {
      const code = (err as { code?: unknown } | undefined)?.code;
      if (code === "ENOENT") {
        return { ok: false, reason: "pdf_extractor_unavailable", errorMessage: "pdftotext binary not found (poppler not installed)" };
      }
      return { ok: false, reason: "pdf_extract_failed", errorMessage: truncate(String(err)) };
    }

    const text = normalizePdfText(stdout);
    if (text.length === 0) {
      // An unread document reported as successfully-read-and-empty is the
      // "couldn't fetch" -> "isn't there" conflation this pipeline exists to
      // prevent — never return ok:true with empty text.
      return { ok: false, reason: "pdf_extract_failed", errorMessage: "pdftotext produced no extractable text" };
    }

    return { ok: true, text, finalUrl: fetched.finalUrl, httpStatus: fetched.httpStatus, contentType: "application/pdf" };
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
