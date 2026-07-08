import { describe, it, expect, vi, afterEach } from "vitest";
import { geocodeUS } from "@/lib/geocode";

const MOCK_ITEM = {
  lat: "37.3861",
  lon: "-122.0839",
  display_name: "Mountain View, Santa Clara County, California, United States",
  boundingbox: ["37.3361", "37.4361", "-122.1339", "-122.0339"],
};

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("geocodeUS", () => {
  it("returns [] and does NOT call fetch for an empty query", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await geocodeUS("   ");
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("includes countrycodes=us and the encoded query in the request URL", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetch([MOCK_ITEM]) as typeof fetch
    );
    await geocodeUS("Mountain View CA");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      ...unknown[]
    ];
    expect(url).toContain("countrycodes=us");
    expect(url).toContain("Mountain+View+CA");
  });

  it("maps lon/lat/label and converts boundingbox to bbox=[minLon,minLat,maxLon,maxLat]", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetch([MOCK_ITEM]) as typeof fetch
    );
    const results = await geocodeUS("Mountain View");
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.lon).toBeCloseTo(-122.0839);
    expect(r.lat).toBeCloseTo(37.3861);
    expect(r.label).toBe(MOCK_ITEM.display_name);
    // boundingbox [minLat, maxLat, minLon, maxLon] → bbox [minLon, minLat, maxLon, maxLat]
    expect(r.bbox).toEqual([
      parseFloat("-122.1339"), // minLon
      parseFloat("37.3361"),   // minLat
      parseFloat("-122.0339"), // maxLon
      parseFloat("37.4361"),   // maxLat
    ]);
  });

  it("throws when res.ok is false (e.g. HTTP 429)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetch(null, false, 429) as typeof fetch
    );
    await expect(geocodeUS("Denver")).rejects.toThrow("Geocoding failed (429)");
  });
});
