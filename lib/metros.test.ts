import { describe, it, expect } from "vitest";
import { METROS, normalizeCounty, getMetroBySlug, metroCountyKey } from "@/lib/metros";

describe("normalizeCounty", () => {
  it("strips a trailing ' County' suffix", () => {
    expect(normalizeCounty("Loudoun County")).toBe("Loudoun");
  });

  it("strips ' County'/' Parish'/' Borough' case-insensitively", () => {
    expect(normalizeCounty("Loudoun county")).toBe("Loudoun");
    expect(normalizeCounty("Loudoun COUNTY")).toBe("Loudoun");
    expect(normalizeCounty("Orleans parish")).toBe("Orleans");
    expect(normalizeCounty("Denali borough")).toBe("Denali");
  });

  it("strips a trailing ' Parish' suffix", () => {
    expect(normalizeCounty("Orleans Parish")).toBe("Orleans");
  });

  it("strips a trailing ' Borough' suffix", () => {
    expect(normalizeCounty("Denali Borough")).toBe("Denali");
  });

  it("leaves an already-bare county name unchanged", () => {
    expect(normalizeCounty("Loudoun")).toBe("Loudoun");
  });

  it("does NOT strip a trailing ' city' suffix — independent cities differ from same-named counties", () => {
    expect(normalizeCounty("Fairfax city")).toBe("Fairfax city");
    expect(normalizeCounty("Richmond City")).toBe("Richmond City");
  });
});

describe("METROS", () => {
  it("has 27 curated metros", () => {
    expect(METROS).toHaveLength(27);
  });

  it("has unique slugs", () => {
    const slugs = METROS.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("stores every county already normalized (no County/Parish/Borough suffix)", () => {
    for (const metro of METROS) {
      for (const [, county] of metro.counties) {
        expect(normalizeCounty(county)).toBe(county);
      }
    }
  });
});

describe("getMetroBySlug", () => {
  it("returns the metro for a known slug", () => {
    const metro = getMetroBySlug("northern-virginia");
    expect(metro).toBeDefined();
    expect(metro?.name).toBe("Northern Virginia");
    expect(metro?.states).toEqual(["VA"]);
  });

  it("returns undefined for an unknown slug", () => {
    expect(getMetroBySlug("not-a-real-metro")).toBeUndefined();
  });
});

describe("metroCountyKey", () => {
  it("is stable across state case and county suffix form (the normalization the live data needs)", () => {
    expect(metroCountyKey("VA", "Loudoun")).toBe(metroCountyKey("va", "Loudoun County"));
  });

  it("differs for the same bare county name in different states", () => {
    expect(metroCountyKey("OR", "Washington")).not.toBe(metroCountyKey("TX", "Washington"));
  });
});
