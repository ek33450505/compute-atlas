import { describe, it, expect } from "vitest";

import facilitiesRaw from "@/data/facilities.json";
import metaRaw from "@/data/facilities.meta.json";
import { HERO_PLATE } from "@/components/home/hero-plate-paths";
import { STATUS_ORDER as STATUS_ORDER_FROM_LIB } from "@/lib/status";
import {
  makeAlbersUsa,
  buildPlateData,
  renderModule,
  assertUsableAsOf,
  OMITTED_JURISDICTIONS,
  STATUS_ORDER,
  WIDTH,
  HEIGHT,
} from "./build-hero-plate.mjs";

/** The subset of a facility this generator reads. */
interface PlateFacility {
  id: string;
  status: string;
  location: { lat: number; lon: number; state: string };
}

const facilities = facilitiesRaw as unknown as PlateFacility[];

/**
 * Anchors verified against d3-geo's albersUsa at the reference framing
 * (960x600, scale 1070). Deliberately written as LITERALS rather than derived
 * from the projection under test — a derived expectation cannot fail.
 */
const ANCHORS: Array<[name: string, lon: number, lat: number, x: number, y: number]> = [
  ["Seattle", -122.3321, 47.6062, 159, 47],
  ["Los Angeles", -118.2437, 34.0522, 150, 308],
  ["Denver", -104.9903, 39.7392, 361, 234],
  ["Chicago", -87.6298, 41.8781, 604, 195],
  ["Loudoun VA", -77.5636, 39.0437, 752, 227],
  ["Miami", -80.1918, 25.7617, 756, 480],
  ["Houston", -95.3698, 29.7604, 499, 428],
  ["Portland ME", -70.2553, 43.6591, 831, 120],
  ["geographic centre", -98.5, 39.5, 453, 244],
];

function facility(
  over: Partial<PlateFacility> & { location?: Partial<PlateFacility["location"]> } = {},
): PlateFacility {
  return {
    id: over.id ?? "test-facility",
    status: over.status ?? "operational",
    location: {
      lat: over.location?.lat ?? 39.5,
      lon: over.location?.lon ?? -98.5,
      state: over.location?.state ?? "KS",
    },
  };
}

describe("STATUS_ORDER — duplicated from lib/status.ts", () => {
  it("matches lib/status.ts exactly, including ORDER", () => {
    // The generated module is `as const satisfies HeroPlate` over
    // `Record<Status, ...>`, which catches an ADD or a RENAME at typecheck but
    // NOT a reorder — key order is not part of a Record's type. Order is the
    // SVG paint order here, so a silent reorder changes which status draws on
    // top of which. This equality is the only thing that catches it, which is
    // why it compares two independently-declared lists rather than deriving
    // one from the other.
    expect(STATUS_ORDER).toEqual([...STATUS_ORDER_FROM_LIB]);
  });
});

describe("makeAlbersUsa — projection", () => {
  const project = makeAlbersUsa(960, 600);

  it.each(ANCHORS)(
    "places %s at the verified anchor",
    (_name, lon, lat, x, y) => {
      const [px, py] = project(lon, lat, "XX") as [number, number];
      // +/-1px: the anchors are integers, the projection is continuous.
      expect(Math.round(px)).toBeGreaterThanOrEqual(x - 1);
      expect(Math.round(px)).toBeLessThanOrEqual(x + 1);
      expect(Math.round(py)).toBeGreaterThanOrEqual(y - 1);
      expect(Math.round(py)).toBeLessThanOrEqual(y + 1);
    },
  );

  it("scales anchors uniformly to the production viewBox", () => {
    // The 1600x1000 plate keeps the reference 8:5 ratio precisely so every
    // anchor scales by WIDTH/960 in BOTH axes. If this breaks, the anchor set
    // above has silently stopped being an oracle for the shipped framing.
    const big = makeAlbersUsa(WIDTH, HEIGHT);
    const k = WIDTH / 960;
    // The anchors are integers carrying the same +/-1px the test above allows,
    // so scaling by k amplifies that to +/-k. Anything beyond is a framing
    // change, not rounding.
    const tolerance = k + 0.01;
    for (const [, lon, lat, x, y] of ANCHORS) {
      const [px, py] = big(lon, lat, "XX") as [number, number];
      expect(Math.abs(px - x * k)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(py - y * k)).toBeLessThanOrEqual(tolerance);
    }
  });
});

describe("makeAlbersUsa — y orientation (screen space, not math space)", () => {
  // The standard Albers formula returns NORTH-POSITIVE y; screen space is
  // south-positive. A naive port that drops the negation in makeAlbers renders
  // the map upside down. An anchor list alone can miss this, because under a
  // pure flip every anchor moves together and a sloppier tolerance would still
  // pass — so assert the ORDERING directly, independently of any anchor value.
  const project = makeAlbersUsa(WIDTH, HEIGHT);
  const yOf = (lon: number, lat: number) => (project(lon, lat, "XX") as [number, number])[1];

  it("puts Seattle above Miami", () => {
    expect(yOf(-122.3321, 47.6062)).toBeLessThan(yOf(-80.1918, 25.7617));
  });

  it("puts Portland ME above Houston", () => {
    expect(yOf(-70.2553, 43.6591)).toBeLessThan(yOf(-95.3698, 29.7604));
  });

  it("puts the northern border above the southern border at one longitude", () => {
    // Same lon, so only latitude varies: nothing but the flip can explain it.
    expect(yOf(-98.5, 48.9)).toBeLessThan(yOf(-98.5, 26.0));
  });

  it("keeps x increasing west to east", () => {
    const xOf = (lon: number, lat: number) =>
      (project(lon, lat, "XX") as [number, number])[0];
    expect(xOf(-122.3321, 47.6062)).toBeLessThan(xOf(-70.2553, 43.6591));
  });
});

describe("makeAlbersUsa — AK and HI insets", () => {
  const project = makeAlbersUsa(WIDTH, HEIGHT);

  /**
   * Where the inset marks actually land, at 1600x1000, plus a 15px margin
   * (~1% of the width). Literals, not imported from the script and not derived
   * from the projection under test.
   *
   * Bounded this tightly on purpose: the earlier boxes were 3-5x looser than
   * the data — Alaska's marks span x 254-257 inside an asserted 150-420 — so
   * an inset translate could have shifted ~80px and still passed, which is not
   * an oracle. Mutation-checked: a 60px shift of the AK translate fails these.
   *
   * ⚠️ These bound TODAY'S mark clouds, not the insets' full drawable area
   * (all of Alaska spans roughly x 67-404 in this framing). A genuinely new
   * facility far from the existing ones can fail these legitimately. Widen
   * them deliberately, after confirming the projection and the translates are
   * unchanged — never to make an unexplained failure go quiet.
   */
  const AK_MARKS = { x0: 239, y0: 686, x1: 272, y1: 815 };
  const HI_MARKS = { x0: 552, y0: 817, x1: 650, y1: 891 };

  /**
   * The wider areas the insets RESERVE. Only the CONUS-collision test below
   * uses these, and it wants them wide: a larger exclusion zone catches more
   * near-misses, so tightening these would WEAKEN that oracle rather than
   * sharpen it.
   */
  const AK_RESERVE = { x0: 150, y0: 660, x1: 420, y1: 1000 };
  const HI_RESERVE = { x0: 500, y0: 800, x1: 700, y1: 960 };

  const inBox = (p: [number, number], b: typeof AK_MARKS) =>
    p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1;

  const akFacilities = facilities.filter((f) => f.location.state === "AK");
  const hiFacilities = facilities.filter((f) => f.location.state === "HI");
  const conusFacilities = facilities.filter(
    (f) =>
      f.location.state !== "AK" &&
      f.location.state !== "HI" &&
      !OMITTED_JURISDICTIONS.has(f.location.state),
  );

  it("has Alaska and Hawaii facilities to place", () => {
    // Guards the two suites below from passing vacuously on an empty filter.
    expect(akFacilities.length).toBeGreaterThan(0);
    expect(hiFacilities.length).toBeGreaterThan(0);
  });

  it("lands every Alaska facility inside the Alaska inset region", () => {
    for (const f of akFacilities) {
      const p = project(f.location.lon, f.location.lat, "AK") as [number, number];
      expect({ id: f.id, inBox: inBox(p, AK_MARKS) }).toEqual({ id: f.id, inBox: true });
    }
  });

  it("lands every Hawaii facility inside the Hawaii inset region", () => {
    for (const f of hiFacilities) {
      const p = project(f.location.lon, f.location.lat, "HI") as [number, number];
      expect({ id: f.id, inBox: inBox(p, HI_MARKS) }).toEqual({ id: f.id, inBox: true });
    }
  });

  it("draws no CONUS facility on top of either inset", () => {
    const collisions = conusFacilities
      .map((f) => ({
        id: f.id,
        p: project(f.location.lon, f.location.lat, f.location.state) as [number, number],
      }))
      .filter(({ p }) => inBox(p, AK_RESERVE) || inBox(p, HI_RESERVE))
      .map(({ id }) => id);
    expect(collisions).toEqual([]);
  });

  it("does not project Alaska into the CONUS conic", () => {
    // Anchorage through the CONUS conic lands far from the inset; if the
    // dispatch is dropped, this is what changes.
    const inset = project(-149.9003, 61.2181, "AK") as [number, number];
    const conus = project(-149.9003, 61.2181, "XX") as [number, number];
    expect(Math.hypot(inset[0] - conus[0], inset[1] - conus[1])).toBeGreaterThan(200);
  });
});

describe("makeAlbersUsa — unrepresentable jurisdictions", () => {
  it("returns null for every territory code, by CODE not by longitude", () => {
    for (const code of ["AS", "GU", "MP", "PR", "VI"]) {
      // Coordinates deliberately inside the CONUS window: a longitude-range
      // guess would happily plot these. Only a code check rejects them.
      expect(project(code)).toBeNull();
    }
    function project(code: string) {
      return makeAlbersUsa(WIDTH, HEIGHT)(-98.5, 39.5, code);
    }
  });

  it("refuses to plot Guam through the CONUS conic", () => {
    // +144.8 deg lon. Any lon-window heuristic ("west of -130 is an inset")
    // misroutes this; the code check is the only thing that catches it.
    expect(makeAlbersUsa(WIDTH, HEIGHT)(144.7937, 13.4443, "GU")).toBeNull();
  });
});

describe("buildPlateData — the real dataset", () => {
  const data = buildPlateData(facilities, WIDTH, HEIGHT);

  const territoryFacilities = facilities.filter((f) =>
    OMITTED_JURISDICTIONS.has(f.location.state),
  );

  it("omits exactly the territory facilities, and reports them", () => {
    expect(territoryFacilities).toHaveLength(9);
    expect(data.omitted).toBe(9);
    expect(data.omittedJurisdictions).toEqual(["GU", "MP", "PR", "VI"]);
  });

  it("omits each territory facility individually", () => {
    const byCode: Record<string, number> = {};
    for (const f of territoryFacilities) {
      byCode[f.location.state] = (byCode[f.location.state] ?? 0) + 1;
    }
    expect(byCode).toEqual({ GU: 4, MP: 2, PR: 2, VI: 1 });
  });

  it("reconciles plotted + deduped + omitted against the input length", () => {
    expect(data.total).toBe(facilities.length);
    expect(data.plotted + data.deduped + data.omitted).toBe(facilities.length);
  });

  it("counts drawn marks per status, summing to plotted", () => {
    const sum = STATUS_ORDER.reduce((acc: number, s: string) => acc + data.counts[s], 0);
    expect(sum).toBe(data.plotted);
    // Every status in the dataset draws something — a silently empty path
    // would just look like "no facilities have that status".
    for (const status of STATUS_ORDER) {
      expect({ status, marks: data.counts[status] > 0 }).toEqual({ status, marks: true });
    }
  });

  it("collapses co-located same-status marks (and actually collapses some)", () => {
    expect(data.deduped).toBeGreaterThan(0);
    for (const status of STATUS_ORDER) {
      const moves = data.paths[status].match(/M-?[\d.]+ -?[\d.]+/g) ?? [];
      expect({ status, unique: new Set(moves).size }).toEqual({
        status,
        unique: moves.length,
      });
    }
  });

  it("emits `d` strings of integer zero-length subpaths, with no NaN", () => {
    for (const status of STATUS_ORDER) {
      const d = data.paths[status];
      expect({ status, nan: d.includes("NaN") }).toEqual({ status, nan: false });
      expect({ status, shape: /^(?:M\d+ \d+h\.01)+$/.test(d) }).toEqual({
        status,
        shape: true,
      });
      expect({ status, marks: d.split("h.01").length - 1 }).toEqual({
        status,
        marks: data.counts[status],
      });
    }
  });

  it("keeps every mark inside the viewBox", () => {
    for (const status of STATUS_ORDER) {
      for (const [, xs, ys] of data.paths[status].matchAll(/M(\d+) (\d+)h\.01/g)) {
        const x = Number(xs);
        const y = Number(ys);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(WIDTH);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(HEIGHT);
      }
    }
  });
});

describe("buildPlateData — fails loudly rather than shipping a wrong plate", () => {
  it("throws when a point projects outside the viewBox", () => {
    // Mexico City, mislabeled as a CONUS jurisdiction: in-range coordinates,
    // out-of-frame result. A silently clipped plate is the failure this catches.
    expect(() =>
      buildPlateData([facility({ location: { lat: 19.4326, lon: -99.1332, state: "TX" } })]),
    ).toThrow(/outside the 1600x1000 viewBox/);
  });

  it("throws on an unrecognized status", () => {
    expect(() => buildPlateData([facility({ status: "decommissioned" })])).toThrow(
      /unrecognized status/,
    );
  });

  it("throws on non-finite coordinates", () => {
    expect(() =>
      buildPlateData([
        facility({ location: { lat: Number.NaN, lon: -98.5, state: "KS" } }),
      ]),
    ).toThrow(/non-finite coordinates/);
  });

  it("throws when location.state is missing or malformed", () => {
    expect(() =>
      buildPlateData([facility({ location: { lat: 39.5, lon: -98.5, state: "Kansas" } })]),
    ).toThrow(/no usable location\.state/);
  });

  it("throws when handed something that is not an array", () => {
    expect(() => buildPlateData({} as unknown as PlateFacility[])).toThrow(
      /expected an array of facilities/,
    );
  });
});

describe("hero-plate-paths.ts — the committed artifact is current", () => {
  // Mirrors lib/siting-context.test.ts: a data wave that forgets
  // `npm run build:mapdata` turns the required check red instead of shipping a
  // plate that silently disagrees with the dataset it claims to draw.
  const data = buildPlateData(facilities, WIDTH, HEIGHT);

  it("matches the paths the generator produces from data/facilities.json", () => {
    expect(HERO_PLATE.paths).toEqual(data.paths);
  });

  it("matches the generator's counts and reconciliation", () => {
    expect({
      counts: { ...HERO_PLATE.counts },
      plotted: HERO_PLATE.plotted,
      deduped: HERO_PLATE.deduped,
      omitted: HERO_PLATE.omitted,
      total: HERO_PLATE.total,
      omittedJurisdictions: [...HERO_PLATE.omittedJurisdictions],
    }).toEqual({
      counts: data.counts,
      plotted: data.plotted,
      deduped: data.deduped,
      omitted: data.omitted,
      total: data.total,
      omittedJurisdictions: data.omittedJurisdictions,
    });
  });

  it("records the viewBox and the snapshot it drew", () => {
    expect(HERO_PLATE.viewBox).toBe(`0 0 ${WIDTH} ${HEIGHT}`);
    expect(HERO_PLATE.width).toBe(WIDTH);
    expect(HERO_PLATE.height).toBe(HEIGHT);
    expect(HERO_PLATE.asOf).toBe((metaRaw as { asOf: string }).asOf);
  });

  it("stays small enough to inline in the server-rendered markup", () => {
    // The whole point is a phone-friendly alternative to the WebGL globe.
    // Measured design target: ~20 KB of path data across 5 nodes.
    const pathBytes = STATUS_ORDER.reduce(
      (sum: number, s: string) => sum + HERO_PLATE.paths[s as keyof typeof HERO_PLATE.paths].length,
      0,
    );
    expect(pathBytes).toBeLessThan(40_000);
  });
});

describe("renderModule", () => {
  const data = buildPlateData(
    [
      facility({ id: "a", status: "operational" }),
      facility({ id: "b", status: "proposed", location: { lat: 41.8781, lon: -87.6298, state: "IL" } }),
    ],
    WIDTH,
    HEIGHT,
  );
  const source = renderModule(data, "2026-01-01T00:00:00.000Z", WIDTH, HEIGHT);

  it("marks the output as generated", () => {
    expect(source).toContain("GENERATED FILE");
    expect(source).toContain("scripts/build-hero-plate.mjs");
  });

  it("emits every status key even when a status has no marks", () => {
    for (const status of STATUS_ORDER) {
      expect({ status, present: source.includes(`    ${status}:`) }).toEqual({
        status,
        present: true,
      });
    }
  });

  it("carries the asOf it was given", () => {
    expect(source).toContain('asOf: "2026-01-01T00:00:00.000Z"');
  });
});

describe("assertUsableAsOf — a corrupt meta file must not emit a broken module", () => {
  // `asOf` is interpolated into a double-quoted TS string literal by
  // renderModule. A merely "non-empty string" check lets a value carrying a
  // quote through, which emits a generated module that does not parse while the
  // generator still exits 0 — the error then surfaces as a confusing typecheck
  // failure in a file nobody hand-wrote. So the guard demands an ISO-8601
  // instant.
  const realAsOf = (metaRaw as { asOf: string }).asOf;

  it("accepts the shape data/facilities.meta.json actually ships", () => {
    // Keeps the pattern honest against production data rather than only
    // against invented ones.
    expect(assertUsableAsOf(realAsOf)).toBe(realAsOf);
  });

  it.each([
    ["a closing quote, which breaks the generated string literal", '2026-09-15T13:17:42.320Z"'],
    ["a quote plus injected source", '2026-01-01T00:00:00.000Z", evil: "yes'],
    ["a bare date — plausible, but not an instant", "2026-09-15"],
    ["a date-time with no zone", "2026-09-15T13:17:42"],
    ["a local-offset instant", "2026-09-15T13:17:42+02:00"],
    ["a newline inside the literal", "2026-09-15T13:17:42.320Z\n"],
    ["free text", "just now"],
    ["the empty string", ""],
  ])("throws on %s", (_label, value) => {
    expect(() => assertUsableAsOf(value)).toThrow(/no usable `asOf`/);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 1_757_941_062_320],
    ["an object", { asOf: "2026-09-15T13:17:42.320Z" }],
  ])("throws on %s", (_label, value) => {
    expect(() => assertUsableAsOf(value)).toThrow(/no usable `asOf`/);
  });

  it("names the offending value in the error, so the fix is obvious", () => {
    expect(() => assertUsableAsOf("2026-09-15")).toThrow(/"2026-09-15"/);
  });
});
