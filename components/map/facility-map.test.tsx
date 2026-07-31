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

interface LayerProps {
  id?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

declare global {
  var __mockMapInstance: MockMapInstance;
  var __layerPropsById: Record<string, LayerProps>;
  var __lastLayerProps: LayerProps;
}

// Mock react-map-gl/maplibre at the module boundary.
// We do NOT mock MapLibre internals (addLayer, filter, cluster painting) — that's
// Playwright's job. We mock only the react-map-gl components and the Map ref methods
// we call from this component: easeTo, fitBounds, getContainer, getMap, setProjection.
vi.mock("react-map-gl/maplibre", () => {
  // Create a persistent container element for all tests to use
  const mockContainer = document.createElement("div");

  const mockMapInstance: MockMapInstance = {
    easeTo: vi.fn(),
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
    getContainer: vi.fn(() => mockContainer),
    getMap: vi.fn(() => ({
      setProjection: vi.fn(),
    })),
  };

  // Expose mockMapInstance globally for tests to inspect spies
  globalThis.__mockMapInstance = mockMapInstance;

  // Layer mock that tracks props passed to it by layer id
  interface MapMockProps {
    onLoad?: (instance: MockMapInstance) => void;
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
  >(({ onLoad, children }, ref) => {
    React.useImperativeHandle(ref, () => mockMapInstance, []);

    // Simulate map load with the mock instance
    React.useEffect(() => {
      if (onLoad) {
        onLoad(mockMapInstance);
      }
    }, [onLoad]);

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
  }: {
    children: React.ReactNode;
    onClose: () => void;
  }): React.ReactElement => (
    <div data-testid="mock-popup" role="region" aria-label="Popup">
      {children}
      <button onClick={onClose}>Close</button>
    </div>
  );
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
      getMap: vi.fn(() => ({
        setProjection: vi.fn(),
      })),
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

vi.mock("@/lib/map", () => ({
  BASEMAP_STYLE_URL: "/basemap/parchment.json",
  INITIAL_VIEW_STATE: { zoom: 4, latitude: 38, longitude: -100, bearing: 0, pitch: 0 },
  SATELLITE_TILE_URL: "https://example.com/satellite/{z}/{x}/{y}.png",
  SATELLITE_ATTRIBUTION: "© Satellite Provider",
  SATELLITE_MAX_ZOOM: 18,
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
    // Reset matchMedia for each test
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

    it("renders the compass rose control", () => {
      render(<FacilityMap facilities={[]} />);
      expect(screen.getByTestId("compass-rose")).toBeInTheDocument();
    });

    it("renders the 3D view toggle", () => {
      render(<FacilityMap facilities={[]} />);
      expect(screen.getByTestId("view-toggle-3d")).toBeInTheDocument();
    });

    it("renders the basemap toggle", () => {
      render(<FacilityMap facilities={[]} />);
      expect(screen.getByTestId("basemap-toggle")).toBeInTheDocument();
    });
  });

  describe("Basemap & Satellite Toggle", () => {
    it("toggles satellite layer visibility on basemap toggle", async () => {
      const user = userEvent.setup();
      render(<FacilityMap facilities={[]} />);

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
});
