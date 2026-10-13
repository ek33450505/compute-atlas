import { vi, describe, it, expect, beforeEach } from "vitest";
import type { SearchEntry } from "@/lib/search";
import { __resetApiRateLimit, API_RATE_LIMIT_MAX } from "@/lib/api-rate-limit";

const { buildNavSearchIndexMock } = vi.hoisted(() => ({
  buildNavSearchIndexMock: vi.fn(),
}));

vi.mock("@/lib/search-index", () => ({
  buildNavSearchIndex: buildNavSearchIndexMock,
}));

import { GET, OPTIONS } from "./route";

const ENTRIES: SearchEntry[] = [
  { type: "operator", label: "Acme", sublabel: "2 facilities", href: "/operators/acme", keywords: "acme" },
  { type: "state", label: "Virginia", sublabel: "5 facilities", href: "/states/virginia", keywords: "virginia va" },
];

function req(): Request {
  return new Request("http://localhost/api/nav-index");
}

describe("GET /api/nav-index", () => {
  beforeEach(() => {
    buildNavSearchIndexMock.mockReset();
    buildNavSearchIndexMock.mockResolvedValue(ENTRIES);
    __resetApiRateLimit();
  });

  it("returns the nav entries with CORS", async () => {
    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: ENTRIES });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("is cacheable for a day at the edge", async () => {
    const cacheControl = (await GET(req())).headers.get("Cache-Control");

    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("s-maxage=86400");
    expect(cacheControl).toContain("stale-while-revalidate=604800");
  });

  it("returns 429 once the per-instance rate limit is exceeded", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await GET(req())).status).toBe(200);
    }
    const blocked = await GET(req());

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(blocked.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers the CORS preflight", () => {
    const res = OPTIONS();

    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
