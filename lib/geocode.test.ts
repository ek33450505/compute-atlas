import { describe, it, expect, vi, afterEach } from "vitest";
import { geocodeUS, parseCoordinateString } from "@/lib/geocode";

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

describe("parseCoordinateString", () => {
  it("parses a plain comma-separated pair", () => {
    expect(parseCoordinateString("39.51, -98.53")).toEqual({ lat: 39.51, lon: -98.53 });
  });

  it("tolerates extra whitespace around each number", () => {
    expect(parseCoordinateString("  39.51   ,   -98.53  ")).toEqual({
      lat: 39.51,
      lon: -98.53,
    });
  });

  it("tolerates no space after the comma", () => {
    expect(parseCoordinateString("39.51,-98.53")).toEqual({ lat: 39.51, lon: -98.53 });
  });

  it("tolerates surrounding parentheses", () => {
    expect(parseCoordinateString("(39.51, -98.53)")).toEqual({ lat: 39.51, lon: -98.53 });
  });

  it("tolerates a trailing degree symbol on each number", () => {
    expect(parseCoordinateString("39.51°, -98.53°")).toEqual({ lat: 39.51, lon: -98.53 });
  });

  it("preserves a negative longitude — every valid US longitude is negative", () => {
    // Regression guard: a parser that silently dropped the sign would place
    // a US facility in China instead of the United States.
    const result = parseCoordinateString("39.51, -98.53");
    expect(result).not.toBeNull();
    expect(result!.lon).toBeLessThan(0);
    expect(result!.lon).toBe(-98.53);
  });

  it("round-trips a negative longitude through Number() without sign loss", () => {
    const result = parseCoordinateString("-33.8688, -151.2093");
    expect(result).toEqual({ lat: -33.8688, lon: -151.2093 });
  });

  it("rejects a latitude out of range (>90)", () => {
    expect(parseCoordinateString("95, -98.53")).toBeNull();
  });

  it("rejects a latitude out of range (<-90)", () => {
    expect(parseCoordinateString("-95, -98.53")).toBeNull();
  });

  it("rejects a longitude out of range (>180)", () => {
    expect(parseCoordinateString("39.51, 200")).toBeNull();
  });

  it("rejects a longitude out of range (<-180)", () => {
    expect(parseCoordinateString("39.51, -200")).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    expect(() => parseCoordinateString("not a coordinate")).not.toThrow();
    expect(parseCoordinateString("not a coordinate")).toBeNull();
    expect(parseCoordinateString("39.51")).toBeNull();
    expect(parseCoordinateString("39.51,,-98.53")).toBeNull();
    expect(parseCoordinateString("")).toBeNull();
    expect(parseCoordinateString("   ")).toBeNull();
    expect(parseCoordinateString("39.51, -98.53, 12")).toBeNull();
    expect(parseCoordinateString("thirty-nine, ninety-eight")).toBeNull();
  });
});
