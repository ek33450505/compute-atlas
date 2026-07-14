import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest — mirrors the hoisted-mock
// convention in lib/search-db.test.ts / submission-detail.test.tsx.
// `searchFacilitiesDb` returns `[]` in Vitest (no DATABASE_URL), so the
// underlying search layer is mocked to exercise the route's response shape.
const { searchFacilitiesDbMock } = vi.hoisted(() => ({
  searchFacilitiesDbMock: vi.fn(),
}));

vi.mock("@/lib/search-db", () => ({
  searchFacilitiesDb: searchFacilitiesDbMock,
}));

import { GET } from "./route";

function req(query: string): Request {
  return new Request(`http://localhost/api/search${query}`);
}

const FIXTURE_FACILITIES: Facility[] = [
  { id: "facility-a", name: "Facility A" } as Facility,
  { id: "facility-b", name: "Facility B" } as Facility,
];

describe("GET /api/search", () => {
  beforeEach(() => {
    searchFacilitiesDbMock.mockReset();
  });

  it("returns matching facilities for a non-empty query", async () => {
    searchFacilitiesDbMock.mockResolvedValue(FIXTURE_FACILITIES);

    const res = await GET(req("?q=hyperscale"));
    const body = await res.json();

    expect(body.count).toBe(2);
    expect(body.facilities.length).toBe(2);
    expect(body.query).toBe("hyperscale");
  });

  it("carries the shared CORS header", async () => {
    searchFacilitiesDbMock.mockResolvedValue([]);

    const res = await GET(req("?q=hyperscale"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns an empty result set for an empty query", async () => {
    searchFacilitiesDbMock.mockResolvedValue([]);

    const res = await GET(req("?q="));
    const body = await res.json();

    expect(body.count).toBe(0);
    expect(body.facilities).toEqual([]);
  });

  it("passes the q param through to searchFacilitiesDb", async () => {
    searchFacilitiesDbMock.mockResolvedValue([]);

    await GET(req("?q=hyperscale"));

    expect(searchFacilitiesDbMock).toHaveBeenCalledWith("hyperscale");
  });
});
