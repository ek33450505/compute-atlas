import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import type { Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself (same pattern as app/states/[state]/page.test.tsx).
const { mockGetStates, mockGetFacilitiesByStateCached } = vi.hoisted(() => ({
  mockGetStates: vi.fn(),
  mockGetFacilitiesByStateCached: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getStates: mockGetStates,
  getFacilitiesByStateCached: mockGetFacilitiesByStateCached,
}));

// The dynamic client wrapper loads react-map-gl/maplibre, which needs
// `window` at module init — mocked at the module boundary (same pattern as
// app/facilities/[slug]/page.test.tsx's facility-mini-map-dynamic mock) so
// this test can assert on the props this route passes through to it without
// a real MapLibre instance.
vi.mock("@/components/map/facility-map-dynamic", () => ({
  FacilityMap: (props: {
    facilities: Facility[];
    chrome?: boolean;
    linksOpenInNewTab?: boolean;
  }) => (
    <div
      data-testid="mock-facility-map"
      data-facility-count={props.facilities.length}
      data-chrome={String(props.chrome)}
      data-links-open-in-new-tab={String(props.linksOpenInNewTab)}
    />
  ),
}));

import EmbedStatePage, { generateMetadata } from "./page";

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 30, lon: -97, city: "Austin", state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Example source", retrievedAt: "2026-01-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

beforeEach(() => {
  mockGetStates.mockReset();
  mockGetFacilitiesByStateCached.mockReset();
});

describe("EmbedStatePage", () => {
  it("throws (notFound) for a slug that isn't a real US state", async () => {
    await expect(
      EmbedStatePage({ params: Promise.resolve({ state: "not-a-real-state" }) })
    ).rejects.toThrow();

    expect(mockGetFacilitiesByStateCached).not.toHaveBeenCalled();
  });

  it("renders the map with the state's facilities, chrome disabled, and the permanent attribution link", async () => {
    mockGetFacilitiesByStateCached.mockResolvedValue([
      makeFacility({ id: "facility-1", name: "Facility One" }),
      makeFacility({ id: "facility-2", name: "Facility Two" }),
    ]);

    const page = await EmbedStatePage({ params: Promise.resolve({ state: "texas" }) });
    render(page);

    const map = screen.getByTestId("mock-facility-map");
    expect(map).toHaveAttribute("data-facility-count", "2");
    expect(map).toHaveAttribute("data-chrome", "false");
    // This route deliberately does NOT pass linksOpenInNewTab any more —
    // FacilityMap now derives the frame-escape itself from usePathname() +
    // isEmbedRoute() (components/footer-gate.tsx), so every /embed/* route
    // gets it automatically without each caller having to remember to pass
    // `true`. Since FacilityMap is mocked here (see the vi.mock above), that
    // derivation itself isn't exercised by this route-level test — it's
    // covered by facility-map.test.tsx's "derives from the route when the
    // prop is omitted" tests instead. What THIS test asserts is narrower but
    // still load-bearing: the page must not pass an explicit `false`, which
    // would override (and defeat) the derivation.
    expect(map).not.toHaveAttribute("data-links-open-in-new-tab", "false");

    const link = screen.getByRole("link", { name: /compute atlas.*texas/i });
    expect(link).toHaveAttribute("href", "https://www.compute-atlas.com/states/texas");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
  });

  it("renders an honest empty state (not a blank map) for a real state with zero facilities", async () => {
    mockGetFacilitiesByStateCached.mockResolvedValue([]);

    const page = await EmbedStatePage({ params: Promise.resolve({ state: "wyoming" }) });
    render(page);

    expect(screen.queryByTestId("mock-facility-map")).not.toBeInTheDocument();
    expect(screen.getByText(/no facilities tracked yet in wyoming/i)).toBeInTheDocument();

    // The attribution bar is unconditional — it must render even when the
    // map itself doesn't, since it's the entire point of offering the embed.
    const link = screen.getByRole("link", { name: /compute atlas.*wyoming/i });
    expect(link).toHaveAttribute("href", "https://www.compute-atlas.com/states/wyoming");
  });
});

describe("EmbedStatePage generateMetadata", () => {
  it("sets robots noindex,nofollow for a known state", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ state: "texas" }) });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toMatch(/texas/i);
  });

  it("sets robots noindex,nofollow for an unknown slug too", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ state: "not-a-real-state" }),
    });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
