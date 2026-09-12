import { describe, it, expect } from "vitest";

import {
  haversineKm,
  addressVariants,
  classifyDistance,
  parseDirFlag,
  WARN_KM,
  FAIL_KM,
} from "./geo-lib.mjs";

describe("thresholds", () => {
  // Pinned as standalone literals, not read back through classifyDistance —
  // a test that only ever exercises the constant through the function it
  // configures can't tell you the constant itself moved.
  it("WARN_KM is 0.5", () => {
    expect(WARN_KM).toBe(0.5);
  });

  it("FAIL_KM is 2", () => {
    expect(FAIL_KM).toBe(2);
  });
});

describe("haversineKm", () => {
  // One degree of arc on a sphere of R = 6371 km is 2*pi*R/360 = 111.1949 km.
  // Pinned against that independently-derived value, not against whatever
  // the function itself returns, in two different axes so a swapped
  // lat/lon argument order would also be caught.
  it("one degree of latitude is ~111.195 km", () => {
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.195, 2);
  });

  it("one degree of longitude at the equator is ~111.195 km", () => {
    expect(haversineKm(0, 0, 0, 1)).toBeCloseTo(111.195, 2);
  });

  it("returns 0 for identical points", () => {
    expect(haversineKm(42.36, -71.06, 42.36, -71.06)).toBe(0);
  });

  it("returns ~half the equatorial circumference for antipodal points", () => {
    // R=6371 -> circumference = 2*pi*R = 40030.17 km; antipodes are half that.
    expect(haversineKm(0, 0, 0, 180)).toBeCloseTo(20015.09, 1);
  });
});

describe("classifyDistance", () => {
  // Boundaries pinned with bare-number literals on BOTH sides, never derived
  // from WARN_KM/FAIL_KM — a fixture built from the same constant as the
  // implementation can never disagree with it. This repo shipped exactly
  // that bug in a sitemap threshold test, and it kept passing when the
  // threshold was raised.
  it("0km is ok", () => {
    expect(classifyDistance(0)).toBe("ok");
  });

  it("0.5km is ok (boundary is exclusive)", () => {
    expect(classifyDistance(0.5)).toBe("ok");
  });

  it("0.51km is warn", () => {
    expect(classifyDistance(0.51)).toBe("warn");
  });

  it("1.9km is warn", () => {
    expect(classifyDistance(1.9)).toBe("warn");
  });

  it("2km is warn (boundary is exclusive)", () => {
    expect(classifyDistance(2)).toBe("warn");
  });

  it("2.01km is fail", () => {
    expect(classifyDistance(2.01)).toBe("fail");
  });

  it("47.8km is fail", () => {
    expect(classifyDistance(47.8)).toBe("fail");
  });
});

describe("addressVariants", () => {
  it("splits a multi-parcel street into two variants, the second being the first parcel alone", () => {
    const variants = addressVariants({
      street: "600 & 800 Friberg Parkway",
      city: "Westborough",
      state: "MA",
      postalCode: "01581",
    });
    expect(variants).toEqual([
      "600 & 800 Friberg Parkway, Westborough, MA, 01581",
      "600 Friberg Parkway, Westborough, MA, 01581",
    ]);
  });

  it("returns exactly one variant for a plain street", () => {
    const variants = addressVariants({
      street: "123 Main Street",
      city: "Boston",
      state: "MA",
      postalCode: "02108",
    });
    expect(variants).toEqual(["123 Main Street, Boston, MA, 02108"]);
  });

  it("appends city, state, and postalCode to the address string", () => {
    const [variant] = addressVariants({
      street: "1 Infinite Loop",
      city: "Cupertino",
      state: "CA",
      postalCode: "95014",
    });
    expect(variant).toContain("Cupertino");
    expect(variant).toContain("CA");
    expect(variant).toContain("95014");
  });
});

describe("parseDirFlag", () => {
  it("errors when --dir is absent entirely", () => {
    const result = parseDirFlag(["node", "geo-check.mjs", "--fix"]);
    expect(result.error).toBeTruthy();
    expect(result.value).toBeUndefined();
  });

  // The regression test that matters: the first version of this gate only
  // checked that a `--dir=` token was PRESENT, so an empty value passed,
  // resolved to the process's own cwd, found nothing to check, and exited 0.
  // An unset `$WAVE_DIR` in a shell script produces exactly this argv.
  it("errors when --dir= is given an empty value (the fail-open regression)", () => {
    const result = parseDirFlag(["node", "geo-check.mjs", "--dir="]);
    expect(result.error).toBeTruthy();
    expect(result.value).toBeUndefined();
  });

  it("errors when --dir= is given a whitespace-only value", () => {
    const result = parseDirFlag(["node", "geo-check.mjs", "--dir=   "]);
    expect(result.error).toBeTruthy();
    expect(result.value).toBeUndefined();
  });

  it("returns the value for a relative path", () => {
    const result = parseDirFlag(["node", "geo-check.mjs", "--dir=wave-2026-09-12"]);
    expect(result.value).toBe("wave-2026-09-12");
    expect(result.error).toBeUndefined();
  });

  it("passes an absolute path through unchanged (resolve, not this parser, handles absoluteness)", () => {
    const result = parseDirFlag(["node", "geo-check.mjs", "--dir=/abs/path"]);
    expect(result.value).toBe("/abs/path");
    expect(result.error).toBeUndefined();
  });

  it("finds --dir among other flags in a realistic argv", () => {
    const result = parseDirFlag(["node", "geo-check.mjs", "--dir=w", "--fix", "--only=MA"]);
    expect(result.value).toBe("w");
    expect(result.error).toBeUndefined();
  });
});
