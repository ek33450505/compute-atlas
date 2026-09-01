import * as path from "node:path";

import { describe, it, expect, vi } from "vitest";

import {
  fetchPdfText,
  normalizePdfText,
  MAX_PDF_BYTES,
  type FetchPdfTextDeps,
} from "./fetch-pdf-text";
import type { GuardedBodyResult } from "./fetch-page-text";

const PDF_BYTES = Buffer.from("%PDF-1.4\n...fake pdf bytes...");

function okGuardedBody(bytes: Buffer, overrides: Partial<Extract<GuardedBodyResult, { ok: true }>> = {}) {
  return vi.fn(
    async (): Promise<GuardedBodyResult> => ({
      ok: true,
      bytes,
      contentType: "application/pdf",
      finalUrl: "https://example.com/doc.pdf",
      httpStatus: 200,
      ...overrides,
    }),
  );
}

function baseDeps(overrides: Partial<FetchPdfTextDeps> = {}): FetchPdfTextDeps {
  return {
    fetchImpl: vi.fn() as unknown as typeof fetch,
    fetchGuardedBodyImpl: okGuardedBody(PDF_BYTES),
    execFileImpl: vi.fn(async () => ({ stdout: "hello from the pdf", stderr: "" })) as unknown as FetchPdfTextDeps["execFileImpl"],
    ...overrides,
  };
}

describe("normalizePdfText", () => {
  it("preserves newlines rather than collapsing them like htmlToText does", () => {
    expect(normalizePdfText("line one\nline two")).toBe("line one\nline two");
  });

  it("collapses interior whitespace runs on each line and trims trailing whitespace", () => {
    expect(normalizePdfText("CRITICAL IT LOAD    240MW   \nfoo\t\tbar")).toBe("CRITICAL IT LOAD 240MW\nfoo bar");
  });

  it("converts form-feed page separators to newlines", () => {
    expect(normalizePdfText("page one\f page two")).toBe("page one\n page two");
  });

  it("collapses 3+ consecutive blank lines down to a single blank line", () => {
    expect(normalizePdfText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("trims leading/trailing whitespace from the whole result", () => {
    expect(normalizePdfText("\n\n  hello  \n\n")).toBe("hello");
  });
});

describe("fetchPdfText", () => {
  it("happy path: returns ok:true with normalized text, finalUrl, and httpStatus", async () => {
    const execFileImpl = vi.fn(async () => ({ stdout: "CRITICAL IT LOAD    240MW\n\n\n\nnext section", stderr: "" }));
    const deps = baseDeps({
      execFileImpl: execFileImpl as unknown as FetchPdfTextDeps["execFileImpl"],
      fetchGuardedBodyImpl: okGuardedBody(PDF_BYTES, { finalUrl: "https://example.com/final.pdf", httpStatus: 200 }),
    });

    const result = await fetchPdfText("https://example.com/doc.pdf", deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.text).toBe("CRITICAL IT LOAD 240MW\n\nnext section");
    expect(result.finalUrl).toBe("https://example.com/final.pdf");
    expect(result.httpStatus).toBe(200);
    expect(result.contentType).toBe("application/pdf");
    expect(execFileImpl).toHaveBeenCalledWith(
      "pdftotext",
      expect.arrayContaining(["-layout", "-q", "-f", "1", "-l"]),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("propagates a too_large failure from the guarded fetch verbatim", async () => {
    const deps = baseDeps({
      fetchGuardedBodyImpl: vi.fn(async (): Promise<GuardedBodyResult> => ({ ok: false, reason: "too_large", httpStatus: 200 })),
    });

    const result = await fetchPdfText("https://example.com/huge.pdf", deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("too_large");
    expect(result.httpStatus).toBe(200);
  });

  it("passes MAX_PDF_BYTES and the application/pdf allowlist to the guarded fetch", async () => {
    const fetchGuardedBodyImpl = okGuardedBody(PDF_BYTES);
    const deps = baseDeps({ fetchGuardedBodyImpl });

    await fetchPdfText("https://example.com/doc.pdf", deps);

    expect(fetchGuardedBodyImpl).toHaveBeenCalledWith(
      "https://example.com/doc.pdf",
      deps,
      { allowedContentTypes: ["application/pdf"], maxBytes: MAX_PDF_BYTES },
    );
  });

  describe("magic-byte check", () => {
    it("rejects a body that isn't really a PDF even though content-type said application/pdf", async () => {
      const htmlBytes = Buffer.from("<html><body>not a pdf</body></html>");
      const deps = baseDeps({ fetchGuardedBodyImpl: okGuardedBody(htmlBytes, { httpStatus: 200 }) });

      const result = await fetchPdfText("https://example.com/lying.pdf", deps);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.reason).toBe("bad_content_type");
      // Must never reach the extractor for bytes that aren't a real PDF.
      expect(deps.execFileImpl).not.toHaveBeenCalled();
    });

    // MUTATION TEST (reported in the completion message): with the
    // hasPdfMagicBytes() check commented out in fetch-pdf-text.ts, this test
    // FAILED (the HTML bytes sailed through to the extractor path and the
    // reason assertion below did not match). Restored, it passes again.
    it("accepts a body that genuinely starts with the %PDF- magic bytes", async () => {
      const deps = baseDeps({ fetchGuardedBodyImpl: okGuardedBody(PDF_BYTES) });
      const result = await fetchPdfText("https://example.com/real.pdf", deps);
      expect(result.ok).toBe(true);
    });
  });

  describe("pdftotext invocation failures", () => {
    it("maps an ENOENT execFile error to pdf_extractor_unavailable", async () => {
      const execFileImpl = vi.fn(async () => {
        throw Object.assign(new Error("spawn pdftotext ENOENT"), { code: "ENOENT" });
      });
      const deps = baseDeps({ execFileImpl: execFileImpl as unknown as FetchPdfTextDeps["execFileImpl"] });

      const result = await fetchPdfText("https://example.com/doc.pdf", deps);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.reason).toBe("pdf_extractor_unavailable");
    });

    it("maps a non-zero exit code to pdf_extract_failed", async () => {
      const execFileImpl = vi.fn(async () => {
        throw Object.assign(new Error("Command failed: pdftotext"), { code: 1 });
      });
      const deps = baseDeps({ execFileImpl: execFileImpl as unknown as FetchPdfTextDeps["execFileImpl"] });

      const result = await fetchPdfText("https://example.com/doc.pdf", deps);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.reason).toBe("pdf_extract_failed");
    });

    it("maps a timeout (execFile's own killed/SIGTERM shape) to pdf_extract_failed", async () => {
      const execFileImpl = vi.fn(async () => {
        throw Object.assign(new Error("pdftotext timed out"), { killed: true, signal: "SIGTERM" });
      });
      const deps = baseDeps({ execFileImpl: execFileImpl as unknown as FetchPdfTextDeps["execFileImpl"] });

      const result = await fetchPdfText("https://example.com/doc.pdf", deps);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.reason).toBe("pdf_extract_failed");
    });
  });

  describe("empty output", () => {
    // MUTATION TEST (reported in the completion message): with the
    // `text.length === 0` guard commented out in fetch-pdf-text.ts, this
    // test FAILED (result.ok was true with text ""). Restored, it passes
    // again — an unread document must never report ok:true with empty text.
    it("treats empty stdout as pdf_extract_failed, never ok:true with empty text", async () => {
      const execFileImpl = vi.fn(async () => ({ stdout: "", stderr: "" }));
      const deps = baseDeps({ execFileImpl: execFileImpl as unknown as FetchPdfTextDeps["execFileImpl"] });

      const result = await fetchPdfText("https://example.com/doc.pdf", deps);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.reason).toBe("pdf_extract_failed");
    });

    it("treats whitespace-only stdout as pdf_extract_failed", async () => {
      const execFileImpl = vi.fn(async () => ({ stdout: "   \n\n\t  \n", stderr: "" }));
      const deps = baseDeps({ execFileImpl: execFileImpl as unknown as FetchPdfTextDeps["execFileImpl"] });

      const result = await fetchPdfText("https://example.com/doc.pdf", deps);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected ok:false");
      expect(result.reason).toBe("pdf_extract_failed");
    });
  });

  describe("temp directory cleanup", () => {
    it("removes the temp dir after a successful extraction", async () => {
      let capturedPdfPath = "";
      const execFileImpl = vi.fn(async (_bin: string, args: string[]) => {
        capturedPdfPath = args[args.length - 2]; // the path arg just before the trailing "-"
        return { stdout: "some real extracted text", stderr: "" };
      });
      const deps = baseDeps({ execFileImpl: execFileImpl as unknown as FetchPdfTextDeps["execFileImpl"] });

      const result = await fetchPdfText("https://example.com/doc.pdf", deps);
      expect(result.ok).toBe(true);

      const tempDir = path.dirname(capturedPdfPath);
      const fs = await import("node:fs/promises");
      await expect(fs.access(tempDir)).rejects.toThrow();
    });

    it("removes the temp dir after a failed extraction", async () => {
      let capturedPdfPath = "";
      const execFileImpl = vi.fn(async (_bin: string, args: string[]) => {
        capturedPdfPath = args[args.length - 2];
        throw Object.assign(new Error("boom"), { code: 1 });
      });
      const deps = baseDeps({ execFileImpl: execFileImpl as unknown as FetchPdfTextDeps["execFileImpl"] });

      const result = await fetchPdfText("https://example.com/doc.pdf", deps);
      expect(result.ok).toBe(false);

      const tempDir = path.dirname(capturedPdfPath);
      const fs = await import("node:fs/promises");
      await expect(fs.access(tempDir)).rejects.toThrow();
    });
  });
});
