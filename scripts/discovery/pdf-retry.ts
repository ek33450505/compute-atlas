import { formatErrorSummary } from "../../lib/db-error";
import type { FetchPageTextResult } from "./fetch-page-text";
import type { FetchPdfTextResult } from "./fetch-pdf-text";

/**
 * Page fetch with the same PDF fallback `extract-fields.ts` uses
 * (`fetchSourceText`): a `bad_content_type` rejection (the page fetcher
 * refuses `application/pdf` on principle) is retried once through
 * `fetchPdfText` (pdftotext) and the extracted text is verified like any other
 * page. A THROWING PDF path is caught and treated as a failure. When the PDF path cannot read it either, the ORIGINAL
 * `bad_content_type` result is returned so verify-source escalates exactly as
 * before; a missing poppler therefore degrades to an escalation, never to a
 * silent accept.
 */
/** Why the PDF fallback could not read a `bad_content_type` page. `pdf_path_threw`
 * is the PDF path throwing (temp dir / spawn trouble), not a verdict on the PDF. */
export type PdfPathFailure =
  | Extract<FetchPdfTextResult, { ok: false }>
  | { ok: false; reason: "pdf_path_threw" };

/**
 * `fetchTextWithPdfRetry` plus the PDF-path failure it otherwise discards, for
 * callers (the leads lane) that must tell "unparseable PDF" from "poppler
 * missing" or "PDF host down". `pdfFailure` is set only when the PDF fallback
 * ran and failed; `result` is exactly what `fetchTextWithPdfRetry` returns.
 */
export async function fetchTextWithPdfRetryDetailed(
  url: string,
  deps: {
    fetchPageTextImpl: (url: string) => Promise<FetchPageTextResult>;
    fetchPdfTextImpl: (url: string) => Promise<FetchPdfTextResult>;
  }
): Promise<{ result: FetchPageTextResult; pdfFailure?: PdfPathFailure }> {
  const pageResult = await deps.fetchPageTextImpl(url);
  if (pageResult.ok || pageResult.reason !== "bad_content_type") return { result: pageResult };
  let pdfResult: FetchPdfTextResult;
  try {
    pdfResult = await deps.fetchPdfTextImpl(url);
  } catch (err) {
    // The PDF path touches the filesystem (temp dir, pdftotext); a throw must
    // degrade to the original bad_content_type (an escalation), never crash the run.
    console.log(`pdf-retry-failed: ${url} — ${formatErrorSummary(err)}`);
    return { result: pageResult, pdfFailure: { ok: false, reason: "pdf_path_threw" } };
  }
  if (pdfResult.ok) {
    return {
      result: { ok: true, text: pdfResult.text, finalUrl: pdfResult.finalUrl, httpStatus: pdfResult.httpStatus, contentType: pdfResult.contentType },
    };
  }
  return { result: pageResult, pdfFailure: pdfResult };
}

export async function fetchTextWithPdfRetry(
  url: string,
  deps: {
    fetchPageTextImpl: (url: string) => Promise<FetchPageTextResult>;
    fetchPdfTextImpl: (url: string) => Promise<FetchPdfTextResult>;
  }
): Promise<FetchPageTextResult> {
  return (await fetchTextWithPdfRetryDetailed(url, deps)).result;
}
