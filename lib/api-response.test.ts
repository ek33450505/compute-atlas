import { describe, it, expect } from "vitest";

import { cacheableJson, API_VERSION, READ_CACHE } from "@/lib/api-response";

describe("cacheableJson", () => {
  it("sets a public Cache-Control with s-maxage and stale-while-revalidate", () => {
    const res = cacheableJson({ ok: true }, READ_CACHE.stats);
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain(`s-maxage=${READ_CACHE.stats.sMaxage}`);
    expect(cacheControl).toContain(`stale-while-revalidate=${READ_CACHE.stats.swr}`);
  });

  it("sets the CC-BY-4.0 license headers", () => {
    const res = cacheableJson({ ok: true }, READ_CACHE.stats);
    expect(res.headers.get("X-License")).toBe("CC-BY-4.0");
    expect(res.headers.get("Link")).toContain("creativecommons.org/licenses/by/4.0");
    expect(res.headers.get("Link")).toContain('rel="license"');
  });

  it("sets X-API-Version", () => {
    const res = cacheableJson({ ok: true }, READ_CACHE.stats);
    expect(res.headers.get("X-API-Version")).toBe(API_VERSION);
  });

  it("preserves the shared CORS headers", () => {
    const res = cacheableJson({ ok: true }, READ_CACHE.stats);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("uses the sMaxage/swr from the given cache window, not a fixed default", () => {
    const search = cacheableJson({ ok: true }, READ_CACHE.search);
    expect(search.headers.get("Cache-Control")).toContain(`s-maxage=${READ_CACHE.search.sMaxage}`);
    expect(search.headers.get("Cache-Control")).not.toContain(`s-maxage=${READ_CACHE.stats.sMaxage}`);
  });
});
