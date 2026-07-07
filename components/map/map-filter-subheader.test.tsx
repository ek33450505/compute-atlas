import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapFilterSubheader } from "./map-filter-subheader";
import type { Facility } from "@/lib/schema";

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
  name: "Alpha Datacenter",
  operator: "AlphaCorp",
  status: "operational",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN" },
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
  aiClassification: "likely",
  confidence: "reported",
  location: { lat: 30.0, lon: -97.0, city: "Austin", state: "TX" },
  capacityMw: { planned: 1200 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-06-01",
};

const fixtures: Facility[] = [facilityA, facilityB];

// ---------------------------------------------------------------------------
// Helpers — zero-state props
// ---------------------------------------------------------------------------

const defaultValues = {
  status: [] as Facility["status"][],
  state: [] as string[],
  operator: [] as string[],
  minMw: 0,
  q: "",
};

const defaultSetters = {
  setStatus: vi.fn(),
  setState: vi.fn(),
  setOperator: vi.fn(),
  setMinMw: vi.fn(),
  setQ: vi.fn(),
};

function renderSubheader(overrides?: {
  values?: Partial<typeof defaultValues>;
  filteredCount?: number;
  totalCount?: number;
}) {
  const values = { ...defaultValues, ...overrides?.values };
  return render(
    <MapFilterSubheader
      facilities={fixtures}
      values={values}
      setters={defaultSetters}
      filteredCount={overrides?.filteredCount ?? fixtures.length}
      totalCount={overrides?.totalCount ?? fixtures.length}
    />
  );
}

// ---------------------------------------------------------------------------
// Always-visible summary row elements
// ---------------------------------------------------------------------------

describe("MapFilterSubheader — summary row (always visible)", () => {
  it("renders the 'View as table' link", () => {
    renderSubheader();
    expect(
      screen.getByRole("link", { name: /view as table/i })
    ).toBeInTheDocument();
  });

  it("renders the live result count region", () => {
    renderSubheader({ filteredCount: 1, totalCount: 2 });
    // role=status live region is always in DOM (even when sr-only on mobile)
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1");
    expect(screen.getByRole("status")).toHaveTextContent("2");
  });

  it("renders the toggle button with aria-expanded", () => {
    renderSubheader();
    // matchMedia mocked to false → starts collapsed
    const toggle = screen.getByRole("button", {
      name: "Expand filter controls",
    });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

// ---------------------------------------------------------------------------
// Collapsed / expanded state
// ---------------------------------------------------------------------------

describe("MapFilterSubheader — collapsed state (default in jsdom, matchMedia → false)", () => {
  it("does not render filter controls when collapsed", () => {
    renderSubheader();
    // FilterBar's status checkboxes are not visible when collapsed
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("expands when the toggle is clicked", async () => {
    const user = userEvent.setup();
    renderSubheader();

    await user.click(
      screen.getByRole("button", { name: "Expand filter controls" })
    );

    // Button label flips to Collapse
    expect(
      screen.getByRole("button", { name: "Collapse filter controls" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse filter controls" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("shows filter controls (checkboxes) after expanding", async () => {
    const user = userEvent.setup();
    renderSubheader();
    await user.click(
      screen.getByRole("button", { name: "Expand filter controls" })
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);
  });

  it("collapses again when the toggle is clicked a second time", async () => {
    const user = userEvent.setup();
    renderSubheader();

    const expandBtn = screen.getByRole("button", {
      name: "Expand filter controls",
    });
    await user.click(expandBtn);
    await user.click(
      screen.getByRole("button", { name: "Collapse filter controls" })
    );

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Active filter count badge
// ---------------------------------------------------------------------------

describe("MapFilterSubheader — active count badge", () => {
  it("does not show the badge when no filters are active", () => {
    renderSubheader();
    expect(screen.queryByLabelText(/active filter/i)).not.toBeInTheDocument();
  });

  it("shows the badge with the correct count for active filters", () => {
    renderSubheader({ values: { state: ["TX"], operator: ["AlphaCorp"] } });
    expect(screen.getByLabelText("2 active filters")).toBeInTheDocument();
  });

  it("uses singular label for exactly one active filter", () => {
    renderSubheader({ values: { state: ["TX"] } });
    expect(screen.getByLabelText("1 active filter")).toBeInTheDocument();
  });
});
