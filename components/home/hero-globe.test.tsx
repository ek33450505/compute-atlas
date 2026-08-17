import type { ReactNode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HeroGlobe, type HeroPoint } from "./hero-globe";
import { HeroGlobe as HeroGlobeDynamic } from "./hero-globe-dynamic";

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

afterEach(() => {
  // Restore the global false-returning stub from vitest.setup.ts between tests.
  window.matchMedia = DEFAULT_MATCH_MEDIA as unknown as typeof window.matchMedia;
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
  it("renders the animated survey graticule as the placeholder on narrow (sub-640px) viewports, and never mounts the real globe", () => {
    // DEFAULT_MATCH_MEDIA returns matches: false for every query, including
    // "(min-width: 640px)" — simulating a phone with no sm+ match, so the
    // mobile gate in hero-globe-dynamic.tsx never allows the dynamic import.
    const { container } = render(<HeroGlobeDynamic points={SAMPLE_POINTS} />);
    expect(container.querySelector(".graticule-survey")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-map")).not.toBeInTheDocument();
  });

  it("swaps in the real globe once the dynamic import resolves on sm+ viewports", async () => {
    window.matchMedia = ((query: string) => ({
      ...DEFAULT_MATCH_MEDIA(query),
      matches: query.includes("min-width: 640px"),
    })) as unknown as typeof window.matchMedia;

    render(<HeroGlobeDynamic points={SAMPLE_POINTS} />);
    await waitFor(() =>
      expect(screen.getByTestId("mock-map")).toBeInTheDocument()
    );
  });
});
