import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import type { ForwardedRef, ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { HeroGlobe, type HeroPoint } from "./hero-globe";
import {
  HeroGlobe as HeroGlobeDynamic,
  HeroGlobeLoadingFrame,
  HeroPlateSlot,
  parseHeroPoints,
} from "./hero-globe-dynamic";
import { HeroPlate } from "./hero-plate";
import { STATUS_ORDER } from "@/lib/status";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// MapLibre can't render in jsdom (no WebGL) — mock react-map-gl/maplibre as
// plain passthrough elements. Map never fires onLoad/onClick on its own; the
// scrim-padding tests below invoke the captured onLoad handler manually (via
// capturedOnLoad) to exercise handleLoad's imperative calls (getMap()
// .setPadding/.setProjection, mapRef.easeTo, etc.) without a real WebGL
// context. Everything else about the map lifecycle stays covered by manual
// browser verification only — see the design-decision comment at the top of
// hero-globe.tsx.
const fakeMapInstance = {
  stop: vi.fn(),
  setProjection: vi.fn(),
  setPadding: vi.fn(),
  getCanvas: vi.fn(() => ({
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
  })),
};
const fakeMapRef = {
  easeTo: vi.fn(),
  getMap: () => fakeMapInstance,
};
let capturedOnLoad: (() => void) | undefined;

vi.mock("react-map-gl/maplibre", () => {
  const Map = forwardRef(function MockMap(
    { children, onLoad }: { children?: ReactNode; onLoad?: () => void },
    ref: ForwardedRef<typeof fakeMapRef>
  ) {
    // Reassigned in an effect (not during render) so this stays a pure
    // render per the react-hooks/no-impure-render rule — capturedOnLoad is
    // only ever read later, from inside a test.
    useEffect(() => {
      capturedOnLoad = onLoad;
    });
    useImperativeHandle(ref, () => fakeMapRef);
    return <div data-testid="mock-map">{children}</div>;
  });
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
  fakeMapInstance.stop.mockClear();
  fakeMapInstance.setProjection.mockClear();
  fakeMapInstance.setPadding.mockClear();
  fakeMapInstance.getCanvas.mockClear();
  fakeMapRef.easeTo.mockClear();
  capturedOnLoad = undefined;
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

// ---------------------------------------------------------------------------
// Scrim padding — the camera must be pushed south of the hero's parchment
// scrim (see HERO_SCRIM_HEIGHT_RATIO in hero-globe.tsx), or the settled view
// shows Mexico/the Caribbean instead of the contiguous US.
// ---------------------------------------------------------------------------

describe("HeroGlobe — scrim padding", () => {
  // handleLoad's applyScrimPadding reads the container's rendered height via
  // getBoundingClientRect(), which jsdom always reports as 0 — mock it
  // per-test rather than relying on real layout, matching the
  // getBoundingClientRect mocking convention already used in
  // components/map/facility-map.test.tsx.
  function mockContainerHeight(height: number) {
    return vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        top: 0,
        left: 0,
        right: 0,
        bottom: height,
        width: 0,
        height,
        x: 0,
        y: 0,
        toJSON: () => {},
      } as DOMRect);
  }

  function lastPaddingTop(): number {
    const call = fakeMapInstance.setPadding.mock.calls.at(-1) as
      | [{ top: number }]
      | undefined;
    expect(call).toBeDefined();
    return call![0].top;
  }

  it("gives the camera a non-zero top padding once the container has a measured height", () => {
    mockContainerHeight(709);
    render(<HeroGlobe points={SAMPLE_POINTS} />);

    expect(typeof capturedOnLoad).toBe("function");
    act(() => {
      capturedOnLoad?.();
    });

    expect(fakeMapInstance.setPadding).toHaveBeenCalled();
    expect(lastPaddingTop()).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });

  // Regression guard for the bug this fix replaces: a hardcoded 373px
  // padding would pass the test above but stay constant regardless of the
  // hero's actual rendered height at other viewport sizes.
  it("scales the top padding with the container's measured height, rather than a fixed pixel value", () => {
    mockContainerHeight(400);
    const { unmount } = render(<HeroGlobe points={SAMPLE_POINTS} />);
    act(() => {
      capturedOnLoad?.();
    });
    const shortTop = lastPaddingTop();
    unmount();
    vi.restoreAllMocks();
    fakeMapInstance.setPadding.mockClear();

    mockContainerHeight(1200);
    render(<HeroGlobe points={SAMPLE_POINTS} />);
    act(() => {
      capturedOnLoad?.();
    });
    const tallTop = lastPaddingTop();

    expect(tallTop).toBeGreaterThan(shortTop);
    vi.restoreAllMocks();
  });

  it("also applies the top padding on the reduced-motion (skipMotion) path, before its early return", () => {
    window.matchMedia = ((query: string) => ({
      ...DEFAULT_MATCH_MEDIA(query),
      matches: query.includes("prefers-reduced-motion"),
    })) as unknown as typeof window.matchMedia;
    mockContainerHeight(709);

    render(<HeroGlobe points={SAMPLE_POINTS} />);

    // The mount/resize effect's synchronous measure() call already invoked
    // applyScrimPadding once during render (before onLoad ever fires — see
    // hero-globe.tsx), recording its own non-zero-top call. Clear it here so
    // the assertion below can only be satisfied by handleLoad's OWN
    // applyScrimPadding call: without this clear, the mount call alone keeps
    // this test green even if handleLoad's call were deleted.
    fakeMapInstance.setPadding.mockClear();

    act(() => {
      capturedOnLoad?.();
    });

    expect(fakeMapInstance.setPadding).toHaveBeenCalled();
    expect(lastPaddingTop()).toBeGreaterThan(0);
    // easeTo is the animated-path-only call; skipMotion must return before
    // reaching it, so the padding fix must not depend on that call.
    expect(fakeMapRef.easeTo).not.toHaveBeenCalled();

    vi.restoreAllMocks();
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
   * The wrapper exactly as app/page.tsx uses it: the plate arrives as an
   * already-rendered NODE from the server component. The wrapper is
   * `"use client"`, so importing the plate inside it would drag
   * hero-plate-paths (~23 KB of path strings) into the eagerly-loaded client
   * chunk — see the bundle-boundary test at the bottom of this file.
   */
  function renderWrapper() {
    return render(<HeroGlobeDynamic plate={<HeroPlate />} />);
  }

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
   * The non-globe state is the static HeroPlate dot map sitting ON the
   * graticule, not the graticule alone — on phones it is the terminal state
   * and therefore the only map they ever get. Assert both: the hairline
   * backdrop AND the plate that carries the data.
   */
  function expectPlateOnGraticule(container: HTMLElement) {
    const graticule = container.querySelector(".graticule-survey");
    expect(graticule).toBeInTheDocument();

    const plate = container.querySelector('svg[role="img"]');
    expect(plate).toBeInTheDocument();
    // The plate is informative, so nothing between it and the document root
    // may be aria-hidden — a role inside an aria-hidden subtree announces
    // nothing while still looking accessible in review.
    for (
      let node: Element | null = plate;
      node !== null && node !== container;
      node = node.parentElement
    ) {
      expect(node.getAttribute("aria-hidden")).not.toBe("true");
    }
    // The graticule stays decorative and hides itself.
    expect(graticule).toHaveAttribute("aria-hidden", "true");
  }

  /**
   * Assert the wrapper is sitting in its OWN placeholder state, not merely
   * "map not painted yet". The distinction matters: next/dynamic's `loading`
   * placeholder renders the same GraticuleSurvey + HeroPlate pair, so neither
   * `.graticule-survey` nor the plate alone can tell "never mounted the globe"
   * from "mounting it this instant". The two wrappers differ in height —
   * HERO_MOBILE_HEIGHT_CLASS's `h-[40vh]` here vs HERO_DEFAULT_HEIGHT_CLASS's
   * `h-[60vh]` there — so the height class is the discriminator.
   */
  function expectDegradedToPlaceholder(container: HTMLElement) {
    const wrapper =
      container.querySelector(".graticule-survey")?.parentElement ?? null;
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveClass("h-[40vh]");
    expectPlateOnGraticule(container);
    expect(screen.queryByTestId("mock-map")).not.toBeInTheDocument();
  }

  it("renders the static dot plate over the survey graticule on narrow (sub-640px) viewports, and never mounts the real globe", () => {
    // DEFAULT_MATCH_MEDIA returns matches: false for every query, including
    // "(min-width: 640px)" — simulating a phone with no sm+ match, so the
    // mobile gate in hero-globe-dynamic.tsx never allows the dynamic import.
    // This is the TERMINAL state on a phone, so "placeholder" here means the
    // real thing: the plate must be present, not just the empty grid.
    stubFetch(okPoints);
    const { container } = renderWrapper();
    expectPlateOnGraticule(container);
    expect(container.querySelectorAll("svg[role='img'] path").length).toBe(
      STATUS_ORDER.length
    );
    expect(screen.queryByTestId("mock-map")).not.toBeInTheDocument();
  });

  it("issues no point-set request below sm — phones pay for neither MapLibre nor the data", () => {
    const fetchMock = stubFetch(okPoints);
    renderWrapper();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the static point artifact and swaps in the real globe on sm+ viewports", async () => {
    allowSmViewport();
    const fetchMock = stubFetch(okPoints);

    renderWrapper();

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

    const { container } = renderWrapper();
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

    const { container } = renderWrapper();
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

    const { container } = renderWrapper();
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

    const { container } = renderWrapper();
    await settleHeroPointsFetch(fetchMock);

    expect(fetchMock).toHaveBeenCalled();
    expectDegradedToPlaceholder(container);
  });

  // Nothing about the plate is imported by this wrapper any more, so a caller
  // that forgets to pass one must degrade rather than throw — the graticule
  // alone, exactly as it behaved before the plate existed.
  it("falls back to the bare graticule when no plate node is passed", () => {
    stubFetch(okPoints);
    const { container } = render(<HeroGlobeDynamic />);

    expect(container.querySelector(".graticule-survey")).toBeInTheDocument();
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(screen.queryByTestId("mock-map")).not.toBeInTheDocument();
  });
});

/**
 * The `loading:` fallback — the frame rendered in the window between the point
 * set landing and the globe chunk arriving.
 *
 * Asserted directly rather than through the component: that window is bounded
 * by a module import resolving, so catching it via the wrapper would be a race
 * dressed up as a test. next/dynamic renders this as a real element inside its
 * own <Suspense> at the wrapper's position (next/dist/shared/lib/lazy-dynamic/
 * loadable.js), which is why it can read the plate out of context at all.
 */
describe("HeroGlobeLoadingFrame", () => {
  it("renders the plate from context, over the graticule, at the mounted globe's height", () => {
    const { container } = render(
      <HeroPlateSlot value={<HeroPlate />}>
        <HeroGlobeLoadingFrame />
      </HeroPlateSlot>
    );

    const graticule = container.querySelector(".graticule-survey");
    expect(graticule).toBeInTheDocument();
    expect(graticule).toHaveAttribute("aria-hidden", "true");

    const plate = container.querySelector('svg[role="img"]');
    expect(plate).toBeInTheDocument();
    expect(plate?.querySelectorAll("path")).toHaveLength(STATUS_ORDER.length);

    // Height discriminator: this frame matches the globe it is standing in for
    // (60vh), not the wrapper's own shorter mobile placeholder (40vh), so the
    // swap is height-stable.
    expect(graticule?.parentElement).toHaveClass("h-[60vh]");
    expect(graticule?.parentElement).not.toHaveClass("h-[40vh]");
  });

  // The plate is informative — it is the only map a phone ever sees, and the
  // reason this wrapper stopped being aria-hidden. A role inside an
  // aria-hidden subtree announces nothing while still looking accessible in
  // review, so walk the whole chain rather than checking the root alone.
  it("hides nothing between the plate and the document root", () => {
    const { container } = render(
      <HeroPlateSlot value={<HeroPlate />}>
        <HeroGlobeLoadingFrame />
      </HeroPlateSlot>
    );

    for (
      let node: Element | null = container.querySelector('svg[role="img"]');
      node !== null && node !== container;
      node = node.parentElement
    ) {
      expect(node.getAttribute("aria-hidden")).not.toBe("true");
    }
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  // Proves it READS the slot rather than importing a plate of its own — the
  // failure mode this whole indirection exists to prevent.
  it("renders no plate when the slot is empty", () => {
    const { container } = render(<HeroGlobeLoadingFrame />);

    expect(container.querySelector(".graticule-survey")).toBeInTheDocument();
    expect(container.querySelector('svg[role="img"]')).toBeNull();
  });
});

/**
 * A bundle-size invariant, which no rendering assertion can see: the wrapper is
 * `"use client"`, so importing the plate (or its path artifact) there ships
 * ~23 KB raw / ~5 KB brotli of `d` strings in the eagerly-loaded client chunk,
 * duplicating data already inline in the SSR'd HTML — paid by exactly the
 * phones the wrapper's mobile gate exists to protect. The plate must arrive as
 * a server-rendered node, and every rendering test above still passes with a
 * re-import, so reading the source is the only lever this suite has.
 *
 * ⚠️ Read the scope literally — an earlier version of this comment claimed to
 * be "the only way to catch a re-import", which overclaims. These two tests
 * read SOURCE TEXT and reach exactly two hops:
 *   1. the wrapper's own `import` statements;
 *   2. the `import` statements of each first-party module the wrapper imports
 *      as a VALUE (`import type` is erased at compile time and cannot ship the
 *      artifact, so following it would only manufacture false failures).
 *
 * What still slips through, unasserted:
 *   · depth ≥ 2 — `wrapper → a → b → hero-plate-paths` is invisible here;
 *   · any non-`import` acquisition: `require`, a dynamic `import()`
 *     expression, or a re-export chain that renames the module on the way
 *     through (the grep is for the literal string "hero-plate");
 *   · a first-party specifier that resolves through a path alias other than
 *     `@/`, or to a file extension outside .ts/.tsx.
 *
 * The assertion that would actually GUARANTEE the invariant is one against the
 * BUILT client chunk — "no `d`-string path artifact in the eagerly-loaded
 * wrapper bundle" — which needs a production build this vitest suite does not
 * run. Until something runs that, treat these as a cheap tripwire on the two
 * likeliest shapes, not as proof of the bundle's contents.
 */
const CLIENT_WRAPPER = "components/home/hero-globe-dynamic.tsx";

// `process.cwd()` (the repo root under vitest), not `import.meta.url` — vite
// does not serve these modules from a file: URL, so `new URL(…,
// import.meta.url)` throws ERR_INVALID_URL_SCHEME here.
const readRepoFile = (relPath: string) =>
  readFileSync(path.join(process.cwd(), relPath), "utf8");

/** Every `import … ;` statement in a source file, multiline forms included. */
const importStatementsOf = (source: string): string[] =>
  source.match(/^import\s[^;]*?;$/gm) ?? [];

/** The module specifier of an import statement — `from "x"` or a bare `import "x"`. */
const specifierOf = (statement: string): string | null =>
  statement.match(/(?:from\s*|^import\s*)["']([^"']+)["']/)?.[1] ?? null;

/**
 * Resolve a FIRST-PARTY specifier (`@/…` or relative) to a repo-relative file
 * path. Returns null for a bare package specifier (`react`, `next/dynamic`),
 * which cannot be the plate artifact, and null for anything that does not land
 * on a .ts/.tsx file — see the scope note above for what that concedes.
 */
function resolveFirstParty(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith("."))
    base = path.normalize(path.join(path.dirname(fromFile), spec));
  else return null;

  const candidates = /\.tsx?$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return (
    candidates.find((c) => existsSync(path.join(process.cwd(), c))) ?? null
  );
}

describe("client bundle boundary", () => {
  it("never imports the plate artifact into the client wrapper", () => {
    const statements = importStatementsOf(readRepoFile(CLIENT_WRAPPER));

    expect(statements.length).toBeGreaterThan(0);
    expect(statements.join("\n")).not.toContain("hero-plate");
  });

  // Depth 1 beyond the wrapper, and no further. This catches the one shape the
  // direct check above structurally cannot see: a wrapper import that is itself
  // innocent-looking while pulling the artifact in behind it.
  it("never reaches the plate artifact through a module it imports (one level)", () => {
    const firstParty = importStatementsOf(readRepoFile(CLIENT_WRAPPER))
      .filter((s) => !/^import\s+type\b/.test(s))
      .map(specifierOf)
      .filter((s): s is string => s !== null)
      .map((spec) => resolveFirstParty(spec, CLIENT_WRAPPER))
      .filter((f): f is string => f !== null);

    // Without this the test is a false proxy: if the resolver ever stops
    // resolving anything (an alias change, a rename), the loop below iterates
    // zero times and the run is green for having checked NOTHING.
    expect(firstParty.length).toBeGreaterThan(0);

    for (const file of firstParty) {
      expect(
        importStatementsOf(readRepoFile(file)).join("\n"),
        `${file} is imported by ${CLIENT_WRAPPER} and pulls the plate artifact into the client graph`
      ).not.toContain("hero-plate");
    }
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
