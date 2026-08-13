import { describe, it, expect, vi } from "vitest";

import { fetchPageText, htmlToText, MAX_RESPONSE_BYTES, type FetchPageTextDeps } from "./fetch-page-text";
import type { ResolveDeps } from "./net-guard";

// Every hostname used below is a plain (non-IP-literal) name, so
// `isBlockedHost` alone never short-circuits `resolvesToBlockedAddress` —
// without injected resolvers this suite would fall through to REAL DNS.
// This fixed pair of fake resolvers is passed on every call so no test ever
// touches the network.
const SAFE_RESOLVE_DEPS: ResolveDeps = {
  resolve4: vi.fn(async () => ["93.184.216.34"]),
  resolve6: vi.fn(async () => {
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  }),
};

function baseDeps(fetchImpl: typeof fetch, overrides: Partial<FetchPageTextDeps> = {}): FetchPageTextDeps {
  return { fetchImpl, resolveDeps: SAFE_RESOLVE_DEPS, ...overrides };
}

/** A minimal streaming-body double: yields `text` split into a handful of
 * chunks so incremental-read behavior is actually exercised. */
function streamingBody(text: string, chunkCount = 4) {
  const bytes = new TextEncoder().encode(text);
  const chunkSize = Math.max(1, Math.ceil(bytes.length / chunkCount));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.slice(i, i + chunkSize));

  let index = 0;
  return {
    getReader: () => ({
      read: vi.fn(async () => {
        if (index >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: chunks[index++] };
      }),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    }),
  };
}

function makeResponse(opts: { status: number; headers?: Record<string, string>; bodyText?: string }): Response {
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    headers: new Headers(opts.headers ?? {}),
    body: opts.bodyText !== undefined ? streamingBody(opts.bodyText) : null,
  } as unknown as Response;
}

describe("htmlToText", () => {
  it("drops script and style elements including their contents", () => {
    const html = "<style>.a{color:red}</style><p>hello</p><script>track('x');</script>";
    expect(htmlToText(html)).toBe("hello");
  });

  it("strips remaining tags", () => {
    expect(htmlToText("<div><h1>Title</h1><p>Body <b>text</b></p></div>")).toBe("Title Body text");
  });

  it("decodes the common named entities", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &lt;3 &quot;fun&quot; &nbsp; it&#39;s &gt; great</p>")).toBe(
      'Tom & Jerry <3 "fun" it\'s > great',
    );
  });

  it("decodes decimal numeric entities", () => {
    expect(htmlToText("<p>caf&#233;</p>")).toBe("café");
  });

  it("collapses whitespace runs, including newlines, into single spaces", () => {
    expect(htmlToText("<p>line one\n\n   line   two</p>")).toBe("line one line two");
  });

  it("does not mistake an escaped, decoded angle bracket for a real tag", () => {
    // Tags are stripped BEFORE entities are decoded, so this literal
    // "&lt;script&gt;" text must survive as visible text, not vanish as if
    // it were a real <script> element.
    expect(htmlToText("<p>example: &lt;script&gt;alert(1)&lt;/script&gt;</p>")).toBe("example: <script>alert(1)</script>");
  });
});

describe("fetchPageText", () => {
  it("fetches a normal 200 HTML page and returns clean extracted text", async () => {
    const html = `<html><head><style>.a{color:red}</style></head><body>
      <script>trackEvent('x');</script>
      <h1>Ridgeline Data Center</h1>
      <p>Capacity &amp; output: 150&nbsp;MW &lt;approx&gt;</p>
    </body></html>`;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      makeResponse({ status: 200, headers: { "content-type": "text/html" }, bodyText: html }),
    );

    const result = await fetchPageText("https://example.com/page", baseDeps(fetchImpl));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.text).not.toContain("trackEvent");
    expect(result.text).not.toContain("color:red");
    expect(result.text).toContain("Ridgeline Data Center");
    expect(result.text).toContain("Capacity & output: 150 MW <approx>");
    expect(result.text).not.toMatch(/\s{2,}/);
    expect(result.finalUrl).toBe("https://example.com/page");
    expect(result.httpStatus).toBe(200);
  });

  it("accepts text/html with a charset parameter (must not false-reject on the parameter)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      makeResponse({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, bodyText: "<p>hello</p>" }),
    );
    const result = await fetchPageText("https://example.com/page", baseDeps(fetchImpl));
    expect(result.ok).toBe(true);
  });

  it("refuses a redirect chain that terminates at a blocked address, never connecting to it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://public.example.com/start") {
        return makeResponse({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
      }
      throw new Error(`must not connect to ${url} — it is the blocked hop`);
    });

    const result = await fetchPageText("https://public.example.com/start", baseDeps(fetchImpl));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("blocked");
    // Only the first (safe) hop was ever connected to.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-validates every redirect hop, not just the first (per-hop regression test)", async () => {
    // start (public) -> intermediate (public) -> final (internal IP).
    // A first-hop-only guard would validate `start` once and then blindly
    // follow both subsequent Location headers; this proves each hop is
    // re-checked before its own connection is made.
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://public.example.com/start") {
        return makeResponse({ status: 302, headers: { location: "https://public.example.com/intermediate" } });
      }
      if (url === "https://public.example.com/intermediate") {
        return makeResponse({ status: 302, headers: { location: "http://127.0.0.1:8080/internal" } });
      }
      throw new Error(`must not connect to ${url} — it is the blocked third hop`);
    });

    const result = await fetchPageText("https://public.example.com/start", baseDeps(fetchImpl));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("blocked");
    expect(fetchImpl).toHaveBeenCalledTimes(2); // start + intermediate; never the blocked third hop
  });

  it("aborts a response that exceeds the size cap while streaming, without buffering the whole body", async () => {
    const totalChunks = 20;
    const chunkBytes = 500_000; // 20 * 500,000 = 10,000,000 bytes, well over the 2MB cap
    let reads = 0;
    const cancel = vi.fn(async () => {});
    const reader = {
      read: vi.fn(async () => {
        if (reads >= totalChunks) return { done: true, value: undefined };
        reads++;
        return { done: false, value: new Uint8Array(chunkBytes) };
      }),
      cancel,
      releaseLock: vi.fn(),
    };
    const res = {
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      body: { getReader: () => reader },
    } as unknown as Response;
    const fetchImpl = vi.fn<typeof fetch>(async () => res);

    const result = await fetchPageText("https://example.com/huge", baseDeps(fetchImpl));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("too_large");
    expect(cancel).toHaveBeenCalledTimes(1);
    // Must have aborted well short of consuming every chunk (proves it
    // never buffered the full 10MB body before checking the cap).
    expect(reader.read.mock.calls.length).toBeLessThan(totalChunks);
  });

  it("rejects a response whose declared Content-Length alone exceeds the cap, without reading the body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      makeResponse({
        status: 200,
        headers: { "content-type": "text/html", "content-length": String(MAX_RESPONSE_BYTES + 1) },
        bodyText: "irrelevant",
      }),
    );
    const result = await fetchPageText("https://example.com/big", baseDeps(fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("too_large");
  });

  it("rejects a non-allowlisted content type such as application/pdf", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      makeResponse({ status: 200, headers: { "content-type": "application/pdf" }, bodyText: "%PDF-1.4 ..." }),
    );
    const result = await fetchPageText("https://example.com/doc.pdf", baseDeps(fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("bad_content_type");
  });

  it("rejects an image content type", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      makeResponse({ status: 200, headers: { "content-type": "image/png" }, bodyText: "binary" }),
    );
    const result = await fetchPageText("https://example.com/pic.png", baseDeps(fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("bad_content_type");
  });

  it("gives up after more than 5 redirect hops", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const hopNumber = Number(url.match(/\/hop(\d+)$/)?.[1] ?? "0");
      return makeResponse({ status: 302, headers: { location: `https://public.example.com/hop${hopNumber + 1}` } });
    });

    const result = await fetchPageText("https://public.example.com/hop0", baseDeps(fetchImpl));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("redirect_limit");
  });

  it("classifies a non-2xx, non-3xx response as http_error with the status attached", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => makeResponse({ status: 404, headers: {} }));
    const result = await fetchPageText("https://example.com/missing", baseDeps(fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("http_error");
    expect(result.httpStatus).toBe(404);
  });

  it("returns network_error (not a throw) when fetchImpl rejects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const result = await fetchPageText("https://example.com/unreachable", baseDeps(fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("network_error");
  });

  it("refuses a non-http(s) scheme without ever calling fetchImpl", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("must not be called");
    });
    const result = await fetchPageText("ftp://example.com/file", baseDeps(fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a URL literal that is itself a blocked IP, without calling fetchImpl", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("must not be called");
    });
    const result = await fetchPageText("http://127.0.0.1/admin", baseDeps(fetchImpl));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns network_error instead of hanging forever when the body stream stalls after headers arrive (slow-loris)", async () => {
    // 200 + text/html + NO content-length (the declared-length pre-check
    // can't catch this), then one small chunk followed by a read() that
    // never resolves on its own — the exact shape that hung the old code,
    // which stopped bounding the fetch the instant headers arrived. The
    // reader only settles that second read() if the per-attempt timer
    // actually aborts the signal, mirroring how a real fetch/undici body
    // stream errors out when its request is aborted mid-read. Because the
    // stalled chunk is tiny (nowhere near MAX_RESPONSE_BYTES), this also
    // doubles as the "don't confuse the size cap with the timeout" case:
    // asserting the exact reason "network_error" rules out a mistaken
    // "too_large".
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      let pulled = false;
      const reader = {
        read: vi.fn(() => {
          if (!pulled) {
            pulled = true;
            return Promise.resolve({ done: false, value: new TextEncoder().encode("<p>partial") });
          }
          return new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
            const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
          });
        }),
        cancel: vi.fn(async () => {}),
        releaseLock: vi.fn(),
      };
      return {
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "text/html" }),
        body: { getReader: () => reader },
      } as unknown as Response;
    });

    const start = Date.now();
    const result = await fetchPageText("https://example.com/slow-loris", baseDeps(fetchImpl, { timeoutMs: 100 }));
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toBe("network_error");
    // Resolves promptly off the per-attempt timeout — not left hanging.
    expect(elapsed).toBeLessThan(2000);
  });
});
