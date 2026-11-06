import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { Explorer } from "./explorer";
import type { Facility } from "@/lib/schema";
import { toMapFacility, toTableRow } from "@/lib/facility-slim";
import { getFilterOptions } from "@/lib/filters";
import * as nav from "next/navigation";

// jsdom can't render the real FacilityMap (MapLibre/WebGL — see the
// render-in-table-view note below). Explorer's OWN logic for what it passes
// down as `isFiltered` is ordinary React state derived from `filtered`/
// `facilities`, though, so mocking only this leaf component lets that
// wiring run for real and be asserted on without a WebGL-capable
// environment — same idiom facility-map.test.tsx itself uses one level
// down (globalThis.__popupProps etc.) to inspect props passed to a mocked
// child.
declare global {
  var __facilityMapProps: { isFiltered?: boolean; facilities?: unknown[] } | undefined;
}

// Table mode reads next/navigation's useSearchParams, which is null outside
// the App Router; the real hook has no provider in jsdom.
vi.mock("next/navigation", () => ({
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@/components/map/facility-map-dynamic", () => ({
  FacilityMap: (props: { isFiltered?: boolean; facilities?: unknown[] }) => {
    globalThis.__facilityMapProps = props;
    return <div data-testid="mock-facility-map" />;
  },
}));

// ---------------------------------------------------------------------------
// Fixtures — ≥4 records across statuses and states
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
  name: "Alpha Datacenter",
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
  name: "Beta Farm",
  operator: "BetaInc",
  status: "proposed",
  facilityType: "data_center",
  aiClassification: "likely",
  confidence: "reported",
  location: { lat: 30.0, lon: -97.0, city: "Austin", state: "TX", precision: "exact" },
  capacityMw: { planned: 1200 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-06-01",
};

const facilityC: Facility = {
  id: "fac-c",
  name: "Gamma Hub",
  operator: "GammaTech",
  status: "under_construction",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "rumored",
  location: { lat: 38.0, lon: -77.0, city: "Reston", state: "VA", precision: "exact" },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2025-01-15",
};

const facilityD: Facility = {
  id: "fac-d",
  name: "Delta Node",
  operator: "DeltaLLC",
  status: "cancelled",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 40.0, lon: -74.0, city: "Newark", state: "NJ", precision: "exact" },
  capacityMw: { operational: 50 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2023-12-01",
};

const all = [facilityA, facilityB, facilityC, facilityD];
const fixtures = all.map(toTableRow);
const mapFixtures = all.map(toMapFacility);

// ---------------------------------------------------------------------------
// Table mode — renders the server-provided page; never filters client-side
// ---------------------------------------------------------------------------

const tableProps = {
  mode: "table" as const,
  rows: fixtures,
  filteredCount: 4,
  totalCount: 4,
  page: 1,
  pageCount: 1,
  options: getFilterOptions(all),
  sort: "capacity" as const,
  dir: "desc" as const,
  q: "",
};

function renderTable(
  overrides: Partial<typeof tableProps> = {},
  searchParams: Record<string, string> = {},
  onUrlUpdate?: (e: { searchParams: URLSearchParams }) => void
) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      <Explorer {...tableProps} {...overrides} />
    </NuqsTestingAdapter>
  );
}

describe("Explorer — table mode", () => {
  it("renders the rows it is given", () => {
    renderTable();
    expect(screen.getAllByRole("row")).toHaveLength(5); // header + 4
    expect(screen.getByRole("link", { name: "Alpha Datacenter" })).toBeInTheDocument();
  });

  it("does not filter rows client-side, even when the URL carries a filter", () => {
    renderTable({}, { status: "operational" });
    expect(screen.getAllByRole("row")).toHaveLength(5);
  });

  it("announces the range on the current page", () => {
    renderTable({ rows: fixtures.slice(0, 2), filteredCount: 1240, totalCount: 2000, page: 2, pageCount: 25 });
    expect(screen.getByRole("status")).toHaveTextContent("Showing 51–52 of 1,240 facilities");
  });

  it("announces an empty result", () => {
    renderTable({ rows: [], filteredCount: 0, pageCount: 1 });
    expect(screen.getByRole("status")).toHaveTextContent("No facilities match these filters");
  });

  it("offers Copy link but no export controls", () => {
    renderTable();
    expect(screen.getByRole("button", { name: "Copy link to this view" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /download|export|csv|json/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /download|export|csv|json/i })).not.toBeInTheDocument();
  });

  it("takes filter options from the server, not the visible rows", async () => {
    const user = userEvent.setup();
    renderTable({ rows: fixtures.slice(0, 1) });
    await user.click(screen.getByRole("button", { name: "State" }));
    // NJ/TX/TN/etc. come from the full set although only one row is rendered.
    expect(screen.getByRole("checkbox", { name: "TX" })).toBeInTheDocument();
  });

  it("a filter change writes the URL and resets page to 1", async () => {
    const user = userEvent.setup();
    const onUrlUpdate = vi.fn();
    renderTable({ page: 3, pageCount: 5 }, { page: "3" }, onUrlUpdate);
    await user.click(screen.getByRole("checkbox", { name: "Operational" }));
    const { searchParams } = onUrlUpdate.mock.calls.at(-1)![0];
    expect(searchParams.get("status")).toBe("operational");
    expect(searchParams.has("page")).toBe(false);
  });

  it("a sort change writes sort/dir and resets page to 1", async () => {
    const user = userEvent.setup();
    const onUrlUpdate = vi.fn();
    renderTable({ page: 2, pageCount: 5 }, { page: "2" }, onUrlUpdate);
    await user.click(screen.getByRole("button", { name: "Sort by Name" }));
    const { searchParams } = onUrlUpdate.mock.calls.at(-1)![0];
    expect(searchParams.get("sort")).toBe("name");
    expect(searchParams.get("dir")).toBe("asc");
    expect(searchParams.has("page")).toBe(false);
  });

  it("Clear all removes filters and the search", async () => {
    const user = userEvent.setup();
    const onUrlUpdate = vi.fn();
    renderTable({}, { status: "operational", q: "alpha" }, onUrlUpdate);
    await user.click(screen.getByRole("button", { name: /clear all/i }));
    const { searchParams } = onUrlUpdate.mock.calls.at(-1)![0];
    expect(searchParams.has("status")).toBe(false);
    expect(searchParams.has("q")).toBe(false);
  });

  it("the map cross-link carries filters but not page, sort or search", () => {
    vi.spyOn(nav, "useSearchParams").mockReturnValue(
      new URLSearchParams("status=operational&page=3&sort=name&dir=asc&q=x") as never
    );
    renderTable();
    expect(screen.getByRole("link", { name: /view map/i })).toHaveAttribute(
      "href",
      "/map?status=operational"
    );
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Map view — empty state
//
// Only the "map filters exclude everything" branch is covered here: it never
// mounts <FacilityMap>, so it's safe in jsdom (see the WebGL note above).
// Verifying that clearing filters brings the map back would require the real
// FacilityMap (MapLibre/WebGL) to mount, which jsdom can't render — skipped
// rather than mocking that entanglement away.
// ---------------------------------------------------------------------------

describe("Explorer — map empty state", () => {
  it("shows a StatePanel instead of the map when filters exclude everything", () => {
    render(
      <NuqsTestingAdapter searchParams={{ status: "permitted" }}>
        <Explorer facilities={mapFixtures} mode="map" />
      </NuqsTestingAdapter>
    );

    expect(
      screen.getByText("No facilities match these filters")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clear all filters" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Interactive datacenter map" })
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// isFiltered wiring (M5) — with a non-empty result set the real FacilityMap
// mounts, which the "map empty state" describe block above avoids entirely.
// FacilityMap is mocked at the module boundary (see the top of this file) so
// this exercises Explorer's own prop-passing logic for real, in both render
// modes that reach the map branch, without needing WebGL.
// ---------------------------------------------------------------------------

describe("Explorer — isFiltered wiring to FacilityMap (M5)", () => {
  it("map mode: isFiltered starts false, flips true once a filter narrows the set, and back to false once that filter is cleared", async () => {
    const user = userEvent.setup();

    render(
      <NuqsTestingAdapter searchParams={{ view: "map" }}>
        <Explorer facilities={mapFixtures} mode="map" />
      </NuqsTestingAdapter>
    );

    expect(await screen.findByTestId("mock-facility-map")).toBeInTheDocument();
    expect(globalThis.__facilityMapProps?.isFiltered).toBe(false);

    // MapFilterSubheader's FilterBar body starts collapsed under the global
    // matchMedia mock (matches: false for every query, vitest.setup.ts) —
    // expand it to reach the status checkboxes.
    await user.click(screen.getByRole("button", { name: "Expand filter controls" }));
    await user.click(screen.getByRole("checkbox", { name: "Operational" }));
    expect(globalThis.__facilityMapProps?.isFiltered).toBe(true);

    // Toggling the SAME checkbox off — not a separate "Clear all" control —
    // is the exact "unchecking the last box" repro path from the original
    // bug report: it's the only filter active, so this returns to zero.
    await user.click(screen.getByRole("checkbox", { name: "Operational" }));
    expect(globalThis.__facilityMapProps?.isFiltered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Map shell height (m13) — the shell used to subtract a hardcoded `4rem`
// (64px) for the sticky site header, but the real header is `h-16` (64px)
// PLUS a `border-b` (1px) = 65px, leaving a 1px scrollHeight/clientHeight
// mismatch on every viewport. Explorer now measures the real `<header>` at
// runtime and overrides the static Tailwind height via an inline style —
// these tests render a stand-in `<header>` (the real SiteHeader lives in the
// root layout, outside what these component tests mount) to exercise that
// measurement, and confirm the static classes remain as the pre-measurement
// fallback.
// ---------------------------------------------------------------------------

describe("Explorer — map shell height (m13)", () => {
  afterEach(() => {
    document.querySelectorAll("header[data-test-header]").forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  it("overrides the static height with the real measured header height (dvh, when svh unsupported)", async () => {
    const header = document.createElement("header");
    header.setAttribute("data-test-header", "");
    document.body.appendChild(header);
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue({
      height: 65,
      top: 0,
      left: 0,
      right: 0,
      bottom: 65,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    } as DOMRect);

    render(
      <NuqsTestingAdapter searchParams={{ view: "map" }}>
        <Explorer facilities={mapFixtures} mode="map" />
      </NuqsTestingAdapter>
    );

    await screen.findByTestId("mock-facility-map");
    const shell = screen.getByTestId("map-shell");

    // jsdom has no `CSS.supports` — the effect's guard falls back to "dvh",
    // exactly the branch that runs whenever the API is unavailable.
    expect(shell.style.height).toBe("calc(100dvh - 65px)");
    // The static Tailwind classes (today's `4rem` fallback) stay in place —
    // the inline style is meant to override them, not replace them, so a
    // pre-measurement render (or a header-less page) still gets a sane value.
    expect(shell.className).toContain("h-[calc(100dvh-4rem)]");
    expect(shell.className).toContain("supports-[height:100svh]:h-[calc(100svh-4rem)]");
  });

  it("prefers svh when CSS.supports reports it available", async () => {
    const header = document.createElement("header");
    header.setAttribute("data-test-header", "");
    document.body.appendChild(header);
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue({
      height: 65,
      top: 0,
      left: 0,
      right: 0,
      bottom: 65,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    } as DOMRect);
    vi.stubGlobal("CSS", { supports: vi.fn(() => true) });

    render(
      <NuqsTestingAdapter searchParams={{ view: "map" }}>
        <Explorer facilities={mapFixtures} mode="map" />
      </NuqsTestingAdapter>
    );

    await screen.findByTestId("mock-facility-map");
    const shell = screen.getByTestId("map-shell");
    expect(shell.style.height).toBe("calc(100svh - 65px)");

    vi.unstubAllGlobals();
  });

  it("leaves the static classes as the only height source when no header is present", async () => {
    render(
      <NuqsTestingAdapter searchParams={{ view: "map" }}>
        <Explorer facilities={mapFixtures} mode="map" />
      </NuqsTestingAdapter>
    );

    await screen.findByTestId("mock-facility-map");
    const shell = screen.getByTestId("map-shell");
    expect(shell.style.height).toBe("");
  });
});
