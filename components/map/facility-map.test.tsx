import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { forwardRef } from "react";
import { FacilityMap } from "./facility-map";
import type { Facility } from "@/lib/schema";

// Type definitions for global test state
interface MockMapInstance {
  easeTo: ReturnType<typeof vi.fn>;
  fitBounds: ReturnType<typeof vi.fn>;
  flyTo: ReturnType<typeof vi.fn>;
  getContainer: ReturnType<typeof vi.fn>;
  getMap: ReturnType<typeof vi.fn>;
}

// The object returned by getMap() — real MapLibre's interaction handlers,
// mocked so handleMapLoad's enable()/disableRotation() calls have something
// to hit.
interface MockMapLibreInstance {
  setProjection: ReturnType<typeof vi.fn>;
  dragPan: { enable: ReturnType<typeof vi.fn> };
  touchZoomRotate: {
    enable: ReturnType<typeof vi.fn>;
    disableRotation: ReturnType<typeof vi.fn>;
  };
  scrollZoom: { enable: ReturnType<typeof vi.fn> };
  boxZoom: { enable: ReturnType<typeof vi.fn> };
  keyboard: { enable: ReturnType<typeof vi.fn> };
  doubleClickZoom: { enable: ReturnType<typeof vi.fn> };
}

interface LayerProps {
  id?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

interface PopupProps {
  anchor?: string;
  offset?: number | Record<string, [number, number]>;
  padding?: { top?: number; bottom?: number; left?: number; right?: number };
}

declare global {
  var __mockMapInstance: MockMapInstance;
  var __mockMapLibreInstance: MockMapLibreInstance;
  var __layerPropsById: Record<string, LayerProps>;
  var __lastLayerProps: LayerProps;
  var __mapGestureProps: { dragRotate?: boolean; touchPitch?: boolean };
  var __popupProps: PopupProps;
}

// Mock react-map-gl/maplibre at the module boundary.
// We do NOT mock MapLibre internals (addLayer, filter, cluster painting) — that's
// Playwright's job. We mock only the react-map-gl components and the Map ref methods
// we call from this component: easeTo, fitBounds, getContainer, getMap, setProjection,
// touchZoomRotate.disableRotation.
vi.mock("react-map-gl/maplibre", () => {
  // Create a persistent container element for all tests to use
  const mockContainer = document.createElement("div");

  // Stable object (not recreated per getMap() call, like the real MapLibre
  // Map instance isn't) so a test can hold a reference to `disableRotation`
  // and assert calls made to it across the component's lifecycle.
  const mockMapLibreInstance: MockMapLibreInstance = {
    setProjection: vi.fn(),
    dragPan: { enable: vi.fn() },
    touchZoomRotate: { enable: vi.fn(), disableRotation: vi.fn() },
    scrollZoom: { enable: vi.fn() },
    boxZoom: { enable: vi.fn() },
    keyboard: { enable: vi.fn() },
    doubleClickZoom: { enable: vi.fn() },
  };

  const mockMapInstance: MockMapInstance = {
    easeTo: vi.fn(),
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
    getContainer: vi.fn(() => mockContainer),
    getMap: vi.fn(() => mockMapLibreInstance),
  };

  // Expose mock instances globally for tests to inspect spies
  globalThis.__mockMapInstance = mockMapInstance;
  globalThis.__mockMapLibreInstance = mockMapLibreInstance;

  // Layer mock that tracks props passed to it by layer id
  interface MapMockProps {
    onLoad?: (instance: MockMapInstance) => void;
    dragRotate?: boolean;
    touchPitch?: boolean;
    children?: React.ReactNode;
  }

  const LayerMock = ({
    id,
    layout,
    paint,
  }: LayerProps): React.ReactElement => {
    if (!globalThis.__layerPropsById) {
      globalThis.__layerPropsById = {};
    }
    if (id) {
      globalThis.__layerPropsById[id] = { layout, paint };
    }
    // Also store the last layer for backward compat
    globalThis.__lastLayerProps = { id, layout, paint };
    return <div data-testid="mock-layer" />;
  };
  LayerMock.displayName = "LayerMock";

  // Map component with ref that exposes mock methods via useImperativeHandle
  const MapMock = forwardRef<
    MockMapInstance,
    MapMockProps & { children?: React.ReactNode }
  >(({ onLoad, dragRotate, touchPitch, children }, ref) => {
    React.useImperativeHandle(ref, () => mockMapInstance, []);

    // Simulate map load with the mock instance
    React.useEffect(() => {
      if (onLoad) {
        onLoad(mockMapInstance);
      }
    }, [onLoad]);

    // Capture the drag/touch gesture props passed by facility-map.tsx so a
    // test can assert drag never tilts/rotates (see LayerMock above for the
    // same synchronous-global-write pattern).
    globalThis.__mapGestureProps = { dragRotate, touchPitch };

    return (
      <div
        data-testid="mock-map"
        style={{ width: "100%", height: "100%" }}
      >
        {children}
      </div>
    );
  });
  MapMock.displayName = "MapMock";

  const Marker = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <div data-testid="mock-marker">{children}</div>
  );
  Marker.displayName = "Marker";

  const Popup = ({
    children,
    onClose,
    anchor,
    offset,
    padding,
  }: PopupProps & {
    children: React.ReactNode;
    onClose: () => void;
  }): React.ReactElement => {
    // Capture the positioning props facility-map.tsx passes so a test can
    // assert on them without a real MapLibre instance to inspect (same
    // synchronous-global-write pattern as __mapGestureProps above).
    globalThis.__popupProps = { anchor, offset, padding };
    return (
      <div data-testid="mock-popup" role="region" aria-label="Popup">
        {children}
        <button onClick={onClose}>Close</button>
      </div>
    );
  };
  Popup.displayName = "Popup";

  const NavigationControl = (): React.ReactElement => (
    <div data-testid="navigation-control" />
  );
  NavigationControl.displayName = "NavigationControl";

  const ScaleControl = (): React.ReactElement => (
    <div data-testid="scale-control" />
  );
  ScaleControl.displayName = "ScaleControl";

  const Source = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <div data-testid="mock-source">{children}</div>
  );
  Source.displayName = "Source";

  return {
    default: MapMock,
    Marker,
    Popup,
    NavigationControl,
    ScaleControl,
    Source,
    Layer: LayerMock,
    useMap: vi.fn(() => ({
      getContainer: vi.fn(() => mockContainer),
      getMap: vi.fn(() => mockMapLibreInstance),
    })),
  };
});

// Mock utility functions to keep tests focused on component behavior, not data logic
vi.mock("@/lib/cluster", () => ({
  clusterFacilities: vi.fn((facilities) =>
    facilities.map((f: Facility) => ({
      id: f.id,
      lon: f.location.lon,
      lat: f.location.lat,
      members: [f],
    }))
  ),
}));

// vi.mock calls are hoisted above regular statements, so a plain `const`
// declared here (even `mock`-prefixed) would still be read before it's
// initialized — vi.hoisted() is the mechanism that actually hoists this
// value alongside vi.mock itself.
const { mockWideAndTallQuery } = vi.hoisted(() => ({
  mockWideAndTallQuery: "(min-width: 640px) and (min-height: 600px)",
}));

vi.mock("@/lib/map", () => ({
  BASEMAP_STYLE_URL: "/basemap/parchment.json",
  INITIAL_VIEW_STATE: { zoom: 4, latitude: 38, longitude: -100, bearing: 0, pitch: 0 },
  SATELLITE_TILE_URL: "https://example.com/satellite/{z}/{x}/{y}.png",
  SATELLITE_ATTRIBUTION: "© Satellite Provider",
  SATELLITE_MAX_ZOOM: 18,
  WIDE_AND_TALL_VIEWPORT_QUERY: mockWideAndTallQuery,
  computeFacilitiesBounds: vi.fn((facilities) => {
    if (facilities.length === 0) return null;
    return {
      center: [facilities[0].location.lon, facilities[0].location.lat],
      bounds: [
        [facilities[0].location.lon - 1, facilities[0].location.lat - 1],
        [facilities[0].location.lon + 1, facilities[0].location.lat + 1],
      ],
      isCoincident: false,
    };
  }),
  buildMarkerLabel: vi.fn((f: Facility) => `${f.name} (${f.operator})`),
  formatLatLon: vi.fn((lat: number, lon: number) => `${lat}, ${lon}`),
}));

vi.mock("@/lib/graticule", () => ({
  buildGraticuleGeoJSON: vi.fn(() => ({
    type: "FeatureCollection",
    features: [],
  })),
  formatLatLon: vi.fn((lat: number, lon: number) => `${lat}, ${lon}`),
}));

vi.mock("@/components/map/facility-marker", () => ({
  FacilityMarker: ({
    facility,
    onSelect,
  }: {
    facility: Facility;
    onSelect: (f: Facility) => void;
  }) => (
    <button onClick={() => onSelect(facility)} data-testid={`marker-${facility.id}`}>
      {facility.name}
    </button>
  ),
}));

vi.mock("@/components/map/cluster-marker", () => ({
  ClusterMarker: ({
    count,
    onSelect,
  }: {
    count: number;
    onSelect: () => void;
  }) => (
    <button onClick={onSelect} data-testid="cluster-marker">
      Cluster {count}
    </button>
  ),
}));

vi.mock("@/components/map/facility-popup", () => ({
  FacilityPopup: ({ facility, onClose }: { facility: Facility; onClose: () => void }) => (
    <div data-testid="facility-popup-content">
      <p>{facility.name}</p>
      <button onClick={onClose}>Close Popup</button>
    </div>
  ),
}));

vi.mock("@/components/map/map-legend", () => ({
  MapLegend: () => <div data-testid="map-legend" />,
}));

vi.mock("@/components/map/compass-rose", () => ({
  CompassRose: ({ onResetNorth }: { onResetNorth: () => void }) => (
    <button onClick={onResetNorth} data-testid="compass-rose">
      Reset North
    </button>
  ),
}));

vi.mock("@/components/map/location-search", () => {
  interface GeocodeResult {
    lon: number;
    lat: number;
  }

  const LocationSearch = ({
    onSelect,
  }: {
    onSelect: (r: GeocodeResult) => void;
  }): React.ReactElement => (
    <button onClick={() => onSelect({ lon: -90, lat: 35 })} data-testid="location-search">
      Search
    </button>
  );
  LocationSearch.displayName = "LocationSearch";

  return { LocationSearch };
});

vi.mock("@/components/map/view-toggle-3d", () => ({
  ViewToggle3D: ({ onToggle }: { onToggle: () => void }) => (
    <button onClick={onToggle} data-testid="view-toggle-3d">
      Toggle 3D
    </button>
  ),
}));

vi.mock("@/components/map/basemap-toggle", () => ({
  BasemapToggle: ({ onToggle }: { onToggle: () => void }) => (
    <button onClick={onToggle} data-testid="basemap-toggle">
      Toggle Basemap
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSource() {
  return {
    url: "https://example.com",
    label: "Example Source",
    retrievedAt: "2024-01-01",
    kind: "press" as const,
  };
}

const facilityA: Facility = {
  id: "fac-a",
  name: "Data Center Alpha",
  operator: "AlphaCorp",
  status: "operational",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN", precision: "exact" },
  capacityMw: { operational: 150 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-01-01",
};

const facilityB: Facility = {
  id: "fac-b",
  name: "Crypto Farm Beta",
  operator: "BetaInc",
  status: "operational",
  facilityType: "crypto_mining",
  confidence: "confirmed",
  location: { lat: 30.0, lon: -97.0, city: "Austin", state: "TX", precision: "exact" },
  capacityMw: { operational: 50 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-06-01",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FacilityMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset matchMedia for each test. Defaults to a "wide and tall" (desktop)
    // viewport — matches: true only for the shared WIDE_AND_TALL_VIEWPORT_QUERY
    // (mocked to mockWideAndTallQuery above), false for every other query
    // (e.g. prefers-reduced-motion), mirroring the old unconditional-false
    // default's effect now that showTools reads a positive "is roomy enough"
    // query directly instead of negating a "(max-width: 768px)" one.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query === mockWideAndTallQuery,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Accessibility & Structure", () => {
    it("renders a region with correct aria-label", () => {
      render(<FacilityMap facilities={[]} />);
      expect(
        screen.getByRole("region", {
          name: "Map of data centers in the United States",
        })
      ).toBeInTheDocument();
    });

    it("includes sr-only guidance text for screen readers", () => {
      const { container } = render(<FacilityMap facilities={[]} />);
      const srOnlyText = container.querySelector(".sr-only");
      expect(srOnlyText).toBeInTheDocument();
      expect(srOnlyText?.textContent).toMatch(/Interactive map/);
      expect(srOnlyText?.textContent).toMatch(/data table page/);
    });

    it("includes a link to the data table alternative in sr-only text", () => {
      render(<FacilityMap facilities={[]} />);
      expect(screen.getByRole("link", { name: "data table page" })).toBeInTheDocument();
    });
  });

  describe("Facility Markers", () => {
    it("renders a marker button for each facility", async () => {
      render(<FacilityMap facilities={[facilityA, facilityB]} />);
      expect(await screen.findByTestId("marker-fac-a")).toBeInTheDocument();
      expect(await screen.findByTestId("marker-fac-b")).toBeInTheDocument();
    });

    it("opens a popup when a facility marker is clicked", async () => {
      const user = userEvent.setup();
      render(<FacilityMap facilities={[facilityA]} />);

      const marker = await screen.findByTestId("marker-fac-a");
      await user.click(marker);

      // Verify popup is rendered
      expect(await screen.findByTestId("mock-popup")).toBeInTheDocument();
      expect(await screen.findByTestId("facility-popup-content")).toBeInTheDocument();
    });

    it("does not pin the popup to a fixed anchor, so MapLibre can flip it to stay inside the map on short viewports", async () => {
      const user = userEvent.setup();
      render(<FacilityMap facilities={[facilityA]} />);

      const marker = await screen.findByTestId("marker-fac-a");
      await user.click(marker);
      await screen.findByTestId("mock-popup");

      // A hardcoded anchor="bottom" always opens the popup ABOVE the marker
      // regardless of available space, clipping its top (name/operator/
      // status/Close button) on short maps — omitting `anchor` lets MapLibre
      // choose whichever side actually fits.
      expect(globalThis.__popupProps.anchor).toBeUndefined();
      // The 16px gap still applies (MapLibre derives a symmetric per-anchor
      // offset from a single number), and padding keeps whichever anchor is
      // chosen clear of the map's own edges.
      expect(globalThis.__popupProps.offset).toBe(16);
      expect(globalThis.__popupProps.padding).toEqual({
        top: 16,
        bottom: 16,
        left: 16,
        right: 16,
      });
    });

    it("closes the popup when the close button is clicked", async () => {
      const user = userEvent.setup();
      render(<FacilityMap facilities={[facilityA]} />);

      // Open popup
      const marker = await screen.findByTestId("marker-fac-a");
      await user.click(marker);
      expect(await screen.findByTestId("facility-popup-content")).toBeInTheDocument();

      // Close popup via Close Popup button
      const closeButton = screen.getByText("Close Popup");
      await user.click(closeButton);

      await waitFor(() => {
        expect(screen.queryByTestId("facility-popup-content")).not.toBeInTheDocument();
      });
    });
  });

  // Note: The component includes focus-return logic (handleClosePopup) to return focus to
  // the triggering marker button after popup closes. This behavior relies on FacilityMarker
  // properly forwarding refs, which our module-boundary mock cannot represent without
  // deeper integration mocking. This behavior is covered by Playwright e2e tests that
  // verify real DOM focus with actual FacilityMarker refs. See: handleClosePopup in
  // facility-map.tsx (lines 120-129).

  describe("Reduced Motion", () => {
    it("applies instant animation (duration 0) when prefers-reduced-motion is enabled", async () => {
      const user = userEvent.setup();
      const mockMapInstance = globalThis.__mockMapInstance;

      // Mock matchMedia to return reduced motion
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: (query: string) => ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });

      render(<FacilityMap facilities={[facilityA]} />);

      // Click a marker to trigger easeTo with duration 0
      const marker = await screen.findByTestId("marker-fac-a");
      await user.click(marker);

      // Verify easeTo was called with duration 0 (reduced motion)
      await waitFor(() => {
        expect(mockMapInstance.easeTo).toHaveBeenCalledWith(
          expect.objectContaining({
            duration: 0,
            center: [-90.0, 35.0],
          })
        );
      });
    });

    it("applies normal animation (duration 600) when prefers-reduced-motion is not enabled", async () => {
      const user = userEvent.setup();
      const mockMapInstance = globalThis.__mockMapInstance;

      // Verify normal behavior (default is no reduced motion)
      render(<FacilityMap facilities={[facilityA]} />);

      const marker = await screen.findByTestId("marker-fac-a");
      await user.click(marker);

      // Verify easeTo was called with duration 600 (normal animation)
      await waitFor(() => {
        expect(mockMapInstance.easeTo).toHaveBeenCalledWith(
          expect.objectContaining({
            duration: 600,
            center: [-90.0, 35.0],
          })
        );
      });
    });
  });

  describe("Drag never tilts/rotates (opt-in 3D only)", () => {
    it("passes dragRotate={false} and touchPitch={false} to the underlying Map", () => {
      render(<FacilityMap facilities={[]} />);
      // A drag must always pan — never tilt or rotate the map. Regressing
      // either prop back to its MapLibre default (undefined/true) restores
      // the ctrl+drag / right-drag / single-touch-pitch tilt gestures.
      expect(globalThis.__mapGestureProps).toEqual({
        dragRotate: false,
        touchPitch: false,
      });
    });

    it("strips the two-finger touch-rotate gesture on load, without disabling touchZoomRotate wholesale", async () => {
      const mockMapLibreInstance = globalThis.__mockMapLibreInstance;

      render(<FacilityMap facilities={[]} />);

      // handleMapLoad calls getMap().touchZoomRotate.disableRotation() —
      // this leaves pinch-to-zoom enabled (per MapLibre's own doc comment on
      // disableRotation) while removing the touch-rotate half of the gesture.
      await waitFor(() => {
        expect(mockMapLibreInstance.touchZoomRotate.disableRotation).toHaveBeenCalled();
      });
    });

    it("force-enables every interaction handler on load, so a reused/never-enabled maplibre instance still works", async () => {
      // Regression test for: single-finger drag-pan (and pinch-zoom,
      // wheel-zoom, box-zoom, double-click-zoom, keyboard pan) silently dead
      // after visiting a facility page (FacilityMiniMap used to pass
      // reuseMaps + interactive={false}, no other handler props) then
      // navigating to /map. `reuseMaps` pools maplibre-gl Map instances in a
      // GLOBAL stack shared by every <Map reuseMaps> in the app;
      // interactive={false} suppresses maplibre-gl's one-time initial
      // handler.enable() calls, and react-map-gl's prop-diffing
      // (`prop ?? true` on both sides) can't detect anything changed when
      // neither component sets a given handler prop explicitly — so a
      // recycled instance's handlers never get (re-)enabled. handleMapLoad
      // must call .enable() on each directly, independent of the <Map> prop
      // values, so the real handler state is correct regardless of prior
      // reuse — belt-and-braces alongside FacilityMiniMap no longer passing
      // reuseMaps at all (components/facility/facility-mini-map.tsx).
      const mockMapLibreInstance = globalThis.__mockMapLibreInstance;

      render(<FacilityMap facilities={[]} />);

      await waitFor(() => {
        expect(mockMapLibreInstance.dragPan.enable).toHaveBeenCalled();
        expect(mockMapLibreInstance.touchZoomRotate.enable).toHaveBeenCalled();
        expect(mockMapLibreInstance.scrollZoom.enable).toHaveBeenCalled();
        expect(mockMapLibreInstance.boxZoom.enable).toHaveBeenCalled();
        expect(mockMapLibreInstance.keyboard.enable).toHaveBeenCalled();
        expect(mockMapLibreInstance.doubleClickZoom.enable).toHaveBeenCalled();
      });
    });

    it("still eases pitch to 55 when ViewToggle3D is toggled on, and back to 0 when toggled off", async () => {
      const user = userEvent.setup();
      const mockMapInstance = globalThis.__mockMapInstance;

      render(<FacilityMap facilities={[]} />);

      // Programmatic camera moves (mapRef.current.easeTo) are a separate API
      // surface from the drag/touch gesture handlers disabled above — the 3D
      // toggle must keep working.
      await user.click(screen.getByTestId("view-toggle-3d"));
      await waitFor(() => {
        expect(mockMapInstance.easeTo).toHaveBeenCalledWith(
          expect.objectContaining({ pitch: 55, duration: 600 })
        );
      });

      await user.click(screen.getByTestId("view-toggle-3d"));
      await waitFor(() => {
        expect(mockMapInstance.easeTo).toHaveBeenCalledWith(
          expect.objectContaining({ pitch: 0, duration: 600 })
        );
      });
    });

    it("still resets bearing and pitch to 0 via the CompassRose reset-north control", async () => {
      const user = userEvent.setup();
      const mockMapInstance = globalThis.__mockMapInstance;

      render(<FacilityMap facilities={[]} />);

      await user.click(screen.getByTestId("compass-rose"));
      await waitFor(() => {
        expect(mockMapInstance.easeTo).toHaveBeenCalledWith(
          expect.objectContaining({ bearing: 0, pitch: 0, duration: 400 })
        );
      });
    });
  });

  describe("Controls & UI Elements", () => {
    it("renders the navigation control", () => {
      render(<FacilityMap facilities={[]} />);
      expect(screen.getByTestId("navigation-control")).toBeInTheDocument();
    });

    it("renders the scale control", () => {
      render(<FacilityMap facilities={[]} />);
      expect(screen.getByTestId("scale-control")).toBeInTheDocument();
    });

    it("renders the map legend", () => {
      render(<FacilityMap facilities={[]} />);
      expect(screen.getByTestId("map-legend")).toBeInTheDocument();
    });

    it("renders the location search", () => {
      render(<FacilityMap facilities={[]} />);
      expect(screen.getByTestId("location-search")).toBeInTheDocument();
    });

    it("defaults the Tools column open on desktop (matchMedia reports no small-viewport match)", () => {
      render(<FacilityMap facilities={[]} />);
      // beforeEach mocks matchMedia to report no match for every query,
      // simulating a desktop viewport — the Tools column should default
      // open so desktop visitors discover the controls without hunting
      // for the toggle.
      expect(screen.getByTestId("compass-rose")).toBeInTheDocument();
      expect(screen.getByTestId("view-toggle-3d")).toBeInTheDocument();
      expect(screen.getByTestId("basemap-toggle")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /hide map tools/i })
      ).toBeInTheDocument();
    });

    it("collapses the Tools column on mount when matchMedia reports the viewport as narrow or short (fails WIDE_AND_TALL_VIEWPORT_QUERY)", () => {
      // A landscape phone (e.g. 844×390) is wide but short, which — like a
      // narrow portrait phone — fails the combined width-AND-height query.
      // The mock here can't simulate real CSS width/height evaluation (see
      // the drift-prevention test below); it stands in for "the query
      // failed for whatever reason" by returning false unconditionally.
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: (query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });

      render(<FacilityMap facilities={[]} />);

      expect(screen.queryByTestId("compass-rose")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /show map tools/i })
      ).toBeInTheDocument();
    });

    it("queries the shared WIDE_AND_TALL_VIEWPORT_QUERY constant (not a hardcoded literal), so this can't drift from MapFilterSubheader's threshold", () => {
      const calls: string[] = [];
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: (query: string) => {
          calls.push(query);
          return {
            matches: query === mockWideAndTallQuery,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          };
        },
      });

      render(<FacilityMap facilities={[]} />);

      expect(calls).toContain(mockWideAndTallQuery);
    });

    it("still toggles the Tools column closed and back open via the disclosure button", async () => {
      const user = userEvent.setup();
      render(<FacilityMap facilities={[]} />);

      await user.click(screen.getByRole("button", { name: /hide map tools/i }));
      expect(screen.queryByTestId("compass-rose")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /show map tools/i }));
      expect(screen.getByTestId("compass-rose")).toBeInTheDocument();
    });
  });

  describe("Tools Panel — measured-top scroll cap", () => {
    // Same pattern as MapLayerControl's scrollMaxHeight tests: the panel's
    // real top offset (not just the viewport height) determines how much
    // room is actually left below it, since it's the last thing in a
    // stacked right-side column.
    it("applies a position-aware inline maxHeight based on the panel's real top offset", () => {
      // Mirrors the measured landscape-phone regression at 320x568: the
      // panel opens at y=242 -> expected maxHeight = 568 - 242 - 16 = 310px.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        top: 242,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      } as DOMRect);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(568);

      render(<FacilityMap facilities={[]} />);

      const panel = document.getElementById("map-tools-panel");
      expect(panel).not.toBeNull();
      expect(panel!.style.maxHeight).toBe("310px");

      vi.restoreAllMocks();
    });

    it("clamps the inline maxHeight to 0 rather than exceeding the real available space", () => {
      // The panel's own top offset already leaves negative room before the
      // viewport bottom (390 - 500 - 16 = -126) — the old static
      // max-h-[calc(100dvh-8rem)] class would have forced far more height
      // than this and relied on the ancestor's overflow-hidden to hide the
      // rest, unreachably.
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        top: 500,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      } as DOMRect);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(390);

      render(<FacilityMap facilities={[]} />);

      const panel = document.getElementById("map-tools-panel");
      expect(panel!.style.maxHeight).toBe("0px");

      vi.restoreAllMocks();
    });
  });

  describe("Basemap & Satellite Toggle", () => {
    it("toggles satellite layer visibility on basemap toggle", async () => {
      const user = userEvent.setup();
      render(<FacilityMap facilities={[]} />);

      // Tools column defaults open on desktop (matchMedia mocked in beforeEach).
      const basemapToggle = screen.getByTestId("basemap-toggle");

      // Initial state: satellite layer should not be visible
      let layerPropsById = globalThis.__layerPropsById;
      expect(layerPropsById?.["esri-satellite-layer"]?.layout?.visibility).toBe("none");

      // Click to toggle to satellite mode
      await user.click(basemapToggle);

      // After toggle: satellite layer should be visible
      await waitFor(() => {
        layerPropsById = globalThis.__layerPropsById;
        expect(layerPropsById?.["esri-satellite-layer"]?.layout?.visibility).toBe("visible");
      });

      // Click again to toggle back to parchment
      await user.click(basemapToggle);

      await waitFor(() => {
        layerPropsById = globalThis.__layerPropsById;
        expect(layerPropsById?.["esri-satellite-layer"]?.layout?.visibility).toBe("none");
      });
    });
  });

  describe("Height & Layout Props", () => {
    it("applies the default heightClass when not provided", () => {
      render(<FacilityMap facilities={[]} />);
      const region = screen.getByRole("region", {
        name: "Map of data centers in the United States",
      });
      expect(region).toHaveClass("h-[70vh]", "min-h-[420px]");
    });

    it("applies a custom heightClass when provided", () => {
      render(<FacilityMap facilities={[]} heightClass="h-full" />);
      const region = screen.getByRole("region", {
        name: "Map of data centers in the United States",
      });
      expect(region).toHaveClass("h-full");
      expect(region).not.toHaveClass("h-[70vh]");
    });
  });

  describe("Radius Ring Tool", () => {
    it("toggles aria-pressed and shows the caption when enabled from the Tools disclosure", async () => {
      const user = userEvent.setup();
      render(<FacilityMap facilities={[]} />);

      const radiusToggle = screen.getByRole("button", { name: /radius rings/i });
      expect(radiusToggle).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByText(/rings: 5 · 10 · 25 mi/)).not.toBeInTheDocument();

      await user.click(radiusToggle);

      expect(radiusToggle).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText(/rings: 5 · 10 · 25 mi/)).toBeInTheDocument();
      expect(screen.getByText(/click map to place/)).toBeInTheDocument();

      await user.click(radiusToggle);

      expect(radiusToggle).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByText(/rings: 5 · 10 · 25 mi/)).not.toBeInTheDocument();
    });
  });

  describe("Layer Overlays (lazy mount)", () => {
    it("does not mount the waterways layer until enabled via the Layers panel", async () => {
      // Fresh slate: __layerPropsById is a shared module-level global that
      // persists across tests in this file, so reset it before asserting
      // absence — a prior test could otherwise leave a stale entry behind.
      globalThis.__layerPropsById = {};

      const user = userEvent.setup();
      render(<FacilityMap facilities={[]} />);

      expect(globalThis.__layerPropsById["water-river-layer"]).toBeUndefined();

      await user.click(screen.getByRole("button", { name: "Show map layers panel" }));
      await user.click(screen.getByLabelText("Waterways"));

      await waitFor(() => {
        expect(globalThis.__layerPropsById["water-river-layer"]).toBeDefined();
      });
    });
  });

  describe("MapLayerControl isSatellite wiring", () => {
    it("disables fill-only overlay toggles once satellite mode is active", async () => {
      const user = userEvent.setup();
      render(<FacilityMap facilities={[]} />);

      await user.click(screen.getByRole("button", { name: "Show map layers panel" }));
      const waterStressToggle = screen.getByLabelText("Baseline water stress");
      expect(waterStressToggle).not.toBeDisabled();

      // BasemapToggle is mocked to a plain button whose onClick flips
      // isSatellite — this exercises the real (unmocked) MapLayerControl's
      // handling of the isSatellite prop now wired in from facility-map.tsx.
      await user.click(screen.getByTestId("basemap-toggle"));

      expect(waterStressToggle).toBeDisabled();
    });
  });

  describe("Coordinate lock readout", () => {
    it("is keyboard-operable and shows a screen-reader-visible readout of the map center once locked", async () => {
      const user = userEvent.setup();
      render(<FacilityMap facilities={[]} />);

      const lockButton = screen.getByRole("button", { name: /show map coordinates readout/i });
      expect(lockButton).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();

      lockButton.focus();
      await user.keyboard("{Enter}");

      expect(lockButton).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.getByRole("button", { name: /hide map coordinates readout/i })
      ).toBeInTheDocument();
      // formatLatLon is mocked as `${lat}, ${lon}`; INITIAL_VIEW_STATE mock is
      // latitude 38 / longitude -100, so that's the map-center readout before
      // any move event fires.
      expect(screen.getByRole("status")).toHaveTextContent("38, -100");
    });
  });

  describe("Empty & Edge Cases", () => {
    it("renders gracefully with an empty facility list", () => {
      render(<FacilityMap facilities={[]} />);
      expect(
        screen.getByRole("region", {
          name: "Map of data centers in the United States",
        })
      ).toBeInTheDocument();
      expect(screen.queryByTestId("marker-fac-a")).not.toBeInTheDocument();
    });

    it("calls fitBounds on mount when surveyOnMount is true and facilities exist", async () => {
      const mockMapInstance = globalThis.__mockMapInstance;
      mockMapInstance.fitBounds.mockClear();
      mockMapInstance.easeTo.mockClear();

      render(<FacilityMap facilities={[facilityA, facilityB]} surveyOnMount={true} />);

      // Survey should call fitBounds (since facilityA and B are at different locations)
      // with duration 1400 (the survey pass duration for normal motion)
      await waitFor(() => {
        expect(mockMapInstance.fitBounds).toHaveBeenCalledWith(
          expect.any(Array), // bounds array
          expect.objectContaining({
            padding: 96,
            maxZoom: 9,
            duration: 1400,
          })
        );
      });
    });

    it("does not call survey camera movement when surveyOnMount is false (default)", async () => {
      const mockMapInstance = globalThis.__mockMapInstance;
      mockMapInstance.fitBounds.mockClear();
      mockMapInstance.easeTo.mockClear();

      render(<FacilityMap facilities={[facilityA, facilityB]} surveyOnMount={false} />);

      // fitBounds should not be called during mount for survey pass
      // (though easeTo might be called for other reasons, so we specifically check fitBounds with duration 1400)
      await waitFor(() => {
        const surveyPassCalls = mockMapInstance.fitBounds.mock.calls.filter(
          (call: unknown[]) => (call[1] as Record<string, unknown>)?.duration === 1400
        );
        expect(surveyPassCalls).toHaveLength(0);
      });
    });

    it("does not call survey on empty facility list even when surveyOnMount is true", async () => {
      const mockMapInstance = globalThis.__mockMapInstance;
      mockMapInstance.fitBounds.mockClear();
      mockMapInstance.easeTo.mockClear();

      render(<FacilityMap facilities={[]} surveyOnMount={true} />);

      // Empty list should not trigger survey (computeFacilitiesBounds returns null)
      await waitFor(() => {
        const surveyPassCalls = mockMapInstance.fitBounds.mock.calls.filter(
          (call: unknown[]) => (call[1] as Record<string, unknown>)?.duration === 1400
        );
        expect(surveyPassCalls).toHaveLength(0);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // M5: clearing the last filter previously threw the camera to a near-global
  // view (fitBounds over the full Alaska-to-Hawaii dataset — measured zoom
  // ~2.146, centered at 51.6N/-112.95, i.e. over Canada/the north Pacific).
  // `isFiltered` tells the ongoing survey-pass effect (not just the mount-time
  // one) whether `facilities` is a real filtered subset (fit its bounds) or
  // the complete unfiltered dataset (reset to INITIAL_VIEW_STATE instead).
  // ---------------------------------------------------------------------------
  describe("Survey pass — camera reset when filters clear (M5)", () => {
    /** Waits until handleMapLoad has run (mapReadyRef is set), so the
     *  post-mount `facilities`-change effect is armed before we rerender. */
    async function waitForMapReady() {
      await waitFor(() => {
        expect(globalThis.__mockMapLibreInstance.dragPan.enable).toHaveBeenCalled();
      });
    }

    it("still fits bounds to the new facilities set on an ordinary filter change (isFiltered true)", async () => {
      const mockMapInstance = globalThis.__mockMapInstance;
      const { rerender } = render(
        <FacilityMap facilities={[facilityA, facilityB]} isFiltered={true} />
      );
      await waitForMapReady();
      mockMapInstance.fitBounds.mockClear();
      mockMapInstance.easeTo.mockClear();

      // Narrowing a filter: facilities shrinks, isFiltered stays true.
      rerender(<FacilityMap facilities={[facilityA]} isFiltered={true} />);

      await waitFor(() => {
        expect(mockMapInstance.fitBounds).toHaveBeenCalledWith(
          expect.any(Array),
          expect.objectContaining({ padding: 96, maxZoom: 9, duration: 1400 })
        );
      });
    });

    it("returns to INITIAL_VIEW_STATE instead of fitting bounds when isFiltered flips to false (Clear all filters)", async () => {
      const mockMapInstance = globalThis.__mockMapInstance;
      const { rerender } = render(
        <FacilityMap facilities={[facilityA]} isFiltered={true} />
      );
      await waitForMapReady();
      mockMapInstance.fitBounds.mockClear();
      mockMapInstance.easeTo.mockClear();

      // "Clear all filters": facilities grows back to the full set AND
      // isFiltered flips to false — the exact M5 repro. Before this fix,
      // this called fitBounds over a US+AK+HI box and zoomed out to a
      // near-global view instead of the default CONUS framing.
      rerender(
        <FacilityMap facilities={[facilityA, facilityB]} isFiltered={false} />
      );

      // INITIAL_VIEW_STATE is mocked to { zoom: 4, latitude: 38, longitude: -100 }.
      await waitFor(() => {
        expect(mockMapInstance.easeTo).toHaveBeenCalledWith({
          center: [-100, 38],
          zoom: 4,
          duration: 1400,
        });
      });
      expect(mockMapInstance.fitBounds).not.toHaveBeenCalled();
    });

    it("uses duration 0 for the reset when prefers-reduced-motion is enabled", async () => {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: (query: string) => ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });

      const mockMapInstance = globalThis.__mockMapInstance;
      const { rerender } = render(
        <FacilityMap facilities={[facilityA]} isFiltered={true} />
      );
      await waitForMapReady();
      mockMapInstance.fitBounds.mockClear();
      mockMapInstance.easeTo.mockClear();

      rerender(
        <FacilityMap facilities={[facilityA, facilityB]} isFiltered={false} />
      );

      await waitFor(() => {
        expect(mockMapInstance.easeTo).toHaveBeenCalledWith({
          center: [-100, 38],
          zoom: 4,
          duration: 0,
        });
      });
    });

    it("defaults isFiltered to true when the prop is omitted, preserving existing fitBounds behavior for callers that don't pass it yet", async () => {
      const mockMapInstance = globalThis.__mockMapInstance;
      const { rerender } = render(<FacilityMap facilities={[facilityA]} />);
      await waitForMapReady();
      mockMapInstance.fitBounds.mockClear();
      mockMapInstance.easeTo.mockClear();

      rerender(<FacilityMap facilities={[facilityA, facilityB]} />);

      await waitFor(() => {
        expect(mockMapInstance.fitBounds).toHaveBeenCalledWith(
          expect.any(Array),
          expect.objectContaining({ padding: 96, maxZoom: 9, duration: 1400 })
        );
      });
      expect(mockMapInstance.easeTo).not.toHaveBeenCalledWith(
        expect.objectContaining({ zoom: 4, center: [-100, 38] })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // M6: tab order previously put ~27+ marker buttons (rendered inside <Map>)
  // before every overlay control — LocationSearch and the Tools column render
  // as JSX siblings AFTER </Map>, which put them after every marker in DOM/tab
  // order. Both are position:absolute with explicit z-20/z-30, so moving them
  // before <Map> in JSX changes tab order without changing paint order.
  // ---------------------------------------------------------------------------
  describe("Tab order — overlay controls precede map markers in DOM order (M6)", () => {
    it("renders LocationSearch and the Tools toggle before the map (and its marker buttons) in DOM order", () => {
      render(<FacilityMap facilities={[facilityA, facilityB]} />);

      const locationSearch = screen.getByTestId("location-search");
      const toolsToggle = screen.getByRole("button", { name: /hide map tools/i });
      const map = screen.getByTestId("mock-map");

      // DOCUMENT_POSITION_FOLLOWING (bit 4) on the map, read from each
      // overlay's perspective, confirms the overlay is earlier in DOM/tab
      // order. Visually they still render "on top" of the map (position:
      // absolute + positive z-index paints above <Map>'s implicit stacking
      // level regardless of DOM order) — only the tab sequence changes.
      expect(
        locationSearch.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        toolsToggle.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("keeps marker buttons reachable only after the overlay controls, never interleaved before them", async () => {
      render(<FacilityMap facilities={[facilityA, facilityB]} />);

      const locationSearch = screen.getByTestId("location-search");
      const toolsToggle = screen.getByRole("button", { name: /hide map tools/i });
      const marker = await screen.findByTestId("marker-fac-a");

      expect(
        locationSearch.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        toolsToggle.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });
  });
});
