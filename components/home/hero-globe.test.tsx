import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { HeroGlobe, type HeroPoint } from "./hero-globe";
import {
  HeroGlobe as HeroGlobeDynamic,
  parseHeroPoints,
} from "./hero-globe-dynamic";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// MapLibre can't render in jsdom (no WebGL) — mock react-map-gl/maplibre as
// plain passthrough elements. Map/Source/Layer never fire onLoad/onClick
// here, so this exercises mount/unmount and prop wiring, not the imperative
// map lifecycle (getMap().setProjection, easeTo, etc. all guard themselves
// with optional chaining and are covered by manual browser verification —
// see the design-decision comment at the top of hero-globe.tsx).
vi.mock("react-map-gl/maplibre", () => {
  const Map = ({ children }: { children?: ReactNode }) => (
    <div data-testid="mock-map">{children}</div>
  );
  const Source = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Layer = () => null;
  return { default: Map, Map, Source, Layer };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_POINTS: HeroPoint[] = [
  { id: "site-a", lat: 39.1, lon: -94.6, status: "operational" },
  { id: "site-b", lat: 33.7, lon: -84.4, status: "under_construction" },
  { id: "site-c", lat: 47.6, lon: -122.3, status: "proposed" },
];

const DEFAULT_MATCH_MEDIA = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

/** Force the sm+ branch of the wrapper's `(min-width: 640px)` gate. */
function allowSmViewport() {
  window.matchMedia = ((query: string) => ({
    ...DEFAULT_MATCH_MEDIA(query),
    matches: query.includes("min-width: 640px"),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  // Restore the global false-returning stub from vitest.setup.ts between tests.
  window.matchMedia = DEFAULT_MATCH_MEDIA as unknown as typeof window.matchMedia;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HeroGlobe", () => {
  it("renders without crashing given sample points", () => {
    const { container } = render(<HeroGlobe points={SAMPLE_POINTS} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.getByTestId("mock-map")).toBeInTheDocument();
  });

  it("renders with an empty point set", () => {
    const { container } = render(<HeroGlobe points={[]} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.getByTestId("mock-map")).toBeInTheDocument();
  });

  it("is hidden from assistive tech (decorative layer — the accessible path is the page's H1 + CTA, not this canvas)", () => {
    const { container } = render(<HeroGlobe points={SAMPLE_POINTS} />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("exposes no focusable per-facility elements (decorative canvas layer, not 700+ DOM markers)", () => {
    render(<HeroGlobe points={SAMPLE_POINTS} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("does not throw when prefers-reduced-motion is enabled", () => {
    window.matchMedia = ((query: string) => ({
      ...DEFAULT_MATCH_MEDIA(query),
      matches: query.includes("prefers-reduced-motion"),
    })) as unknown as typeof window.matchMedia;

    expect(() => render(<HeroGlobe points={SAMPLE_POINTS} />)).not.toThrow();
    expect(screen.getByTestId("mock-map")).toBeInTheDocument();
  });

  it("does not throw on a coarse (touch) pointer", () => {
    window.matchMedia = ((query: string) => ({
      ...DEFAULT_MATCH_MEDIA(query),
      matches: query.includes("pointer: coarse"),
    })) as unknown as typeof window.matchMedia;

    expect(() => render(<HeroGlobe points={SAMPLE_POINTS} />)).not.toThrow();
  });
});

describe("HeroGlobe dynamic wrapper", () => {
  function stubFetch(impl: () => Promise<Response>) {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const okPoints = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(SAMPLE_POINTS),
    } as Response);

  /**
   * Deterministic settle point for the wrapper's fetch → json → setState chain.
   *
   * The degrade tests assert an ABSENCE, which is trivially true on tick 0:
   * `waitFor` runs its callback synchronously on entry, and at that moment
   * `points` is still null, so the placeholder is on screen no matter what the
   * fetch is about to do. Awaiting the mock's own promise, then crossing one
   * macrotask boundary inside `act`, moves the assertion to the terminal
   * state. That boundary is a guarantee rather than a race — every link in the
   * component's chain is a microtask, and the microtask queue always drains
   * completely before the next macrotask runs — so this is not a fixed sleep.
   */
  async function settleHeroPointsFetch(
    fetchMock: ReturnType<typeof stubFetch>
  ) {
    await Promise.allSettled(fetchMock.mock.results.map((r) => r.value));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /**
   * Assert the wrapper is sitting in its OWN placeholder state, not merely
   * "map not painted yet". The distinction matters: next/dynamic's `loading`
   * placeholder renders the same GraticuleSurvey, so `.graticule-survey` alone
   * cannot tell "never mounted the globe" from "mounting it this instant".
   * The two plates differ in height — HERO_MOBILE_HEIGHT_CLASS's `h-[40vh]`
   * here vs HERO_DEFAULT_HEIGHT_CLASS's `h-[60vh]` there — so the height class
   * is the discriminator.
   */
  function expectDegradedToPlaceholder(container: HTMLElement) {
    const plate =
      container.querySelector(".graticule-survey")?.parentElement ?? null;
    expect(plate).not.toBeNull();
    expect(plate).toHaveClass("h-[40vh]");
    expect(screen.queryByTestId("mock-map")).not.toBeInTheDocument();
  }

  it("renders the animated survey graticule as the placeholder on narrow (sub-640px) viewports, and never mounts the real globe", () => {
    // DEFAULT_MATCH_MEDIA returns matches: false for every query, including
    // "(min-width: 640px)" — simulating a phone with no sm+ match, so the
    // mobile gate in hero-globe-dynamic.tsx never allows the dynamic import.
    stubFetch(okPoints);
    const { container } = render(<HeroGlobeDynamic />);
    expect(container.querySelector(".graticule-survey")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-map")).not.toBeInTheDocument();
  });

  it("issues no point-set request below sm — phones pay for neither MapLibre nor the data", () => {
    const fetchMock = stubFetch(okPoints);
    render(<HeroGlobeDynamic />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the static point artifact and swaps in the real globe on sm+ viewports", async () => {
    allowSmViewport();
    const fetchMock = stubFetch(okPoints);

    render(<HeroGlobeDynamic />);

    await waitFor(() =>
      expect(screen.getByTestId("mock-map")).toBeInTheDocument()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/data/hero-points.json",
      expect.objectContaining({ signal: expect.anything() })
    );
  });

  it("degrades to the graticule placeholder without throwing when the fetch rejects", async () => {
    allowSmViewport();
    const fetchMock = stubFetch(() =>
      Promise.reject(new Error("network down"))
    );

    const { container } = render(<HeroGlobeDynamic />);
    await settleHeroPointsFetch(fetchMock);

    expect(fetchMock).toHaveBeenCalled();
    expectDegradedToPlaceholder(container);
  });

  it("degrades to the graticule placeholder on a non-OK response, without reading the body", async () => {
    allowSmViewport();
    // The body deliberately RESOLVES to a valid point set: a rejecting json()
    // would be absorbed by the same `.catch()` as any other failure, making
    // "we never read a non-OK body" unobservable — dropping the `res.ok` check
    // would still leave the placeholder up and the test still green. With a
    // usable body, skipping that check mounts the globe and this test fails.
    const json = vi.fn(() => Promise.resolve(SAMPLE_POINTS));
    const fetchMock = stubFetch(() =>
      Promise.resolve({ ok: false, json } as unknown as Response)
    );

    const { container } = render(<HeroGlobeDynamic />);
    await settleHeroPointsFetch(fetchMock);

    expect(fetchMock).toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expectDegradedToPlaceholder(container);
  });

  it("degrades to the graticule placeholder when the artifact is not an array of points", async () => {
    allowSmViewport();
    const fetchMock = stubFetch(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ error: "not an array" }),
      } as unknown as Response)
    );

    const { container } = render(<HeroGlobeDynamic />);
    await settleHeroPointsFetch(fetchMock);

    expect(fetchMock).toHaveBeenCalled();
    expectDegradedToPlaceholder(container);
  });

  it("degrades to the graticule placeholder when every point in the artifact is malformed", async () => {
    allowSmViewport();
    const fetchMock = stubFetch(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: "no-coords", status: "operational" },
            { lat: 39.1, lon: -94.6, status: "operational" },
          ]),
      } as unknown as Response)
    );

    const { container } = render(<HeroGlobeDynamic />);
    await settleHeroPointsFetch(fetchMock);

    expect(fetchMock).toHaveBeenCalled();
    expectDegradedToPlaceholder(container);
  });
});

// The component-level tests above assert the user-visible contract (a bad
// artifact leaves the graticule on screen). They cannot distinguish "returned
// []" from "threw": the fetch chain's `.catch()` absorbs a throw into the same
// placeholder state, so they pass either way. These assert the function's own
// contract — total, never throwing, whatever the CDN serves.
describe("parseHeroPoints", () => {
  it("returns [] for a non-array object without throwing", () => {
    expect(() => parseHeroPoints({ error: "not an array" })).not.toThrow();
    expect(parseHeroPoints({ error: "not an array" })).toEqual([]);
  });

  it("returns [] for null and undefined without throwing", () => {
    expect(() => parseHeroPoints(null)).not.toThrow();
    expect(parseHeroPoints(null)).toEqual([]);
    expect(parseHeroPoints(undefined)).toEqual([]);
  });

  it("returns [] for a string without throwing", () => {
    expect(() => parseHeroPoints("[]")).not.toThrow();
    expect(parseHeroPoints("[]")).toEqual([]);
  });

  it("drops malformed entries — missing id, non-finite lat/lon, non-objects", () => {
    const parsed = parseHeroPoints([
      SAMPLE_POINTS[0],
      { lat: 1, lon: 2, status: "operational" }, // no id
      { id: "no-lat", lon: 2 }, // missing lat
      { id: "nan-lat", lat: Number.NaN, lon: 2 },
      { id: "inf-lon", lat: 1, lon: Number.POSITIVE_INFINITY },
      { id: "string-lat", lat: "39.1", lon: -94.6 },
      null,
      "site-z",
    ]);

    expect(parsed).toEqual([SAMPLE_POINTS[0]]);
  });

  // Without the status check the predicate lies: it claims `p is HeroPoint`
  // having verified only id/lat/lon. Such a point survives to the globe, misses
  // every arm of its MapLibre `match` on "status" (hero-globe.tsx), and paints
  // as *cancelled* grey — a plausible-looking wrong dot, never an error.
  //
  // Verified by removing the check; this test then prints
  //   AssertionError: expected [ …(5) ] to deeply equal
  //   [ { id: 'site-a', lat: 39.1, …(2) } ]
  // over a diff listing the four entries it wrongly kept (no-status,
  // unknown-status, null-status, numeric-status).
  it("drops points whose status is missing or outside the Status union", () => {
    const parsed = parseHeroPoints([
      SAMPLE_POINTS[0],
      { id: "no-status", lat: 1, lon: 2 },
      { id: "unknown-status", lat: 1, lon: 2, status: "decommissioned" },
      { id: "null-status", lat: 1, lon: 2, status: null },
      { id: "numeric-status", lat: 1, lon: 2, status: 3 },
    ]);

    expect(parsed).toEqual([SAMPLE_POINTS[0]]);
  });

  it("keeps a point for every status the globe can paint", () => {
    const oneOfEach = [
      "operational",
      "under_construction",
      "permitted",
      "proposed",
      "cancelled",
    ].map((status, i) => ({ id: `site-${status}`, lat: i, lon: -i, status }));

    expect(parseHeroPoints(oneOfEach)).toEqual(oneOfEach);
  });

  it("returns [] for an array whose every entry is malformed", () => {
    expect(parseHeroPoints([null, {}, 7, { id: "x" }])).toEqual([]);
  });

  it("keeps every well-formed point", () => {
    expect(parseHeroPoints(SAMPLE_POINTS)).toEqual(SAMPLE_POINTS);
  });
});
