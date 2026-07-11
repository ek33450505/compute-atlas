import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FacilityTable } from "./facility-table";
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

const facilityAlpha: Facility = {
  id: "alpha-facility",
  name: "Alpha Center",
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

const facilityBeta: Facility = {
  id: "beta-facility",
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

const facilityGamma: Facility = {
  id: "gamma-facility",
  name: "Gamma Hub",
  operator: "GammaTech",
  status: "under_construction",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "rumored",
  location: { lat: 38.0, lon: -77.0, city: "Reston", state: "VA", precision: "exact" },
  // no capacity
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2025-01-15",
};

const fixtures = [facilityAlpha, facilityBeta, facilityGamma];

// ---------------------------------------------------------------------------
// Header tests
// ---------------------------------------------------------------------------

describe("FacilityTable — headers", () => {
  it("renders all required column headers", () => {
    render(<FacilityTable facilities={fixtures} />);
    expect(screen.getByRole("columnheader", { name: /name/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /operator/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /status/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /location/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /capacity/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /confidence/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /updated/i })).toBeInTheDocument();
  });

  it("has a caption (visible to assistive tech)", () => {
    const { container } = render(<FacilityTable facilities={fixtures} />);
    const caption = container.querySelector("caption");
    expect(caption).toBeInTheDocument();
    expect(caption?.textContent).toMatch(/AI datacenters/i);
  });
});

// ---------------------------------------------------------------------------
// Row content tests
// ---------------------------------------------------------------------------

describe("FacilityTable — row content", () => {
  it("renders a link to /facilities/<id> for each facility name", () => {
    render(<FacilityTable facilities={fixtures} />);
    const alphaLink = screen.getByRole("link", { name: "Alpha Center" });
    expect(alphaLink).toHaveAttribute("href", "/facilities/alpha-facility");
  });

  it("renders the StatusBadge label text for each row", () => {
    render(<FacilityTable facilities={fixtures} />);
    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.getByText("Under construction")).toBeInTheDocument();
  });

  it("formats operational capacity correctly", () => {
    render(<FacilityTable facilities={fixtures} />);
    expect(screen.getByText("150 MW")).toBeInTheDocument();
  });

  it("formats planned-only capacity with 'planned' suffix", () => {
    render(<FacilityTable facilities={fixtures} />);
    expect(screen.getByText("1,200 MW planned")).toBeInTheDocument();
  });

  it("shows em dash for facility with no capacity", () => {
    render(<FacilityTable facilities={fixtures} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders location as City, State", () => {
    render(<FacilityTable facilities={fixtures} />);
    expect(screen.getByText("Memphis, TN")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Accessibility: aria-sort
// ---------------------------------------------------------------------------

describe("FacilityTable — aria-sort", () => {
  it("sortable headers start with aria-sort='none'", () => {
    render(<FacilityTable facilities={fixtures} />);
    const nameHeader = screen.getByRole("columnheader", { name: /name/i });
    expect(nameHeader).toHaveAttribute("aria-sort", "none");
  });

  it("sortable header button has accessible label", () => {
    render(<FacilityTable facilities={fixtures} />);
    const nameHeader = screen.getByRole("columnheader", { name: /name/i });
    const sortButton = within(nameHeader).getByRole("button");
    expect(sortButton).toHaveAttribute("aria-label", "Sort by Name");
  });

  it("non-sortable headers do not have aria-sort", () => {
    render(<FacilityTable facilities={fixtures} />);
    const confidenceHeader = screen.getByRole("columnheader", { name: /confidence/i });
    expect(confidenceHeader).not.toHaveAttribute("aria-sort");
  });
});

// ---------------------------------------------------------------------------
// Sorting interaction
// ---------------------------------------------------------------------------

describe("FacilityTable — sorting", () => {
  it("clicking Name header sets aria-sort to ascending", async () => {
    const user = userEvent.setup();
    render(<FacilityTable facilities={fixtures} />);
    const nameHeader = screen.getByRole("columnheader", { name: /name/i });
    const sortButton = within(nameHeader).getByRole("button");
    await user.click(sortButton);
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
  });

  it("clicking Name header twice sets aria-sort to descending", async () => {
    const user = userEvent.setup();
    render(<FacilityTable facilities={fixtures} />);
    const nameHeader = screen.getByRole("columnheader", { name: /name/i });
    const sortButton = within(nameHeader).getByRole("button");
    await user.click(sortButton);
    await user.click(sortButton);
    expect(nameHeader).toHaveAttribute("aria-sort", "descending");
  });

  it("sorting by Name ascending places Alpha before Beta", async () => {
    const user = userEvent.setup();
    render(<FacilityTable facilities={fixtures} />);
    const nameHeader = screen.getByRole("columnheader", { name: /name/i });
    const sortButton = within(nameHeader).getByRole("button");
    await user.click(sortButton); // ascending

    const rows = screen.getAllByRole("row");
    // rows[0] is the header row; rows[1] is the first data row
    expect(within(rows[1]).getByRole("link")).toHaveTextContent("Alpha Center");
  });

  it("sorting by Name descending places Gamma before Beta", async () => {
    const user = userEvent.setup();
    render(<FacilityTable facilities={fixtures} />);
    const nameHeader = screen.getByRole("columnheader", { name: /name/i });
    const sortButton = within(nameHeader).getByRole("button");
    await user.click(sortButton); // ascending
    await user.click(sortButton); // descending

    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByRole("link")).toHaveTextContent("Gamma Hub");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("FacilityTable — empty state", () => {
  it("renders the empty-state message when facilities is empty", () => {
    render(<FacilityTable facilities={[]} />);
    expect(
      screen.getByText("No facilities match your filters.")
    ).toBeInTheDocument();
  });

  it("renders no data rows when facilities is empty", () => {
    render(<FacilityTable facilities={[]} />);
    // Only the header row + the single empty-state row should exist
    const rows = screen.getAllByRole("row");
    // 1 header row + 1 empty state row = 2 rows total
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Default sort — capacity descending, no-capacity last
// ---------------------------------------------------------------------------

describe("FacilityTable — default sort", () => {
  it("defaults to capacity descending: largest first, no-capacity last", () => {
    render(<FacilityTable facilities={fixtures} />);
    const rows = screen.getAllByRole("row");
    // rows[0] = header. Beta (1200) > Alpha (150) > Gamma (no capacity).
    expect(within(rows[1]).getByRole("link")).toHaveTextContent("Beta Farm");
    expect(within(rows[2]).getByRole("link")).toHaveTextContent("Alpha Center");
    expect(within(rows[3]).getByRole("link")).toHaveTextContent("Gamma Hub");
  });

  it("capacity header starts with aria-sort='descending'", () => {
    render(<FacilityTable facilities={fixtures} />);
    const capHeader = screen.getByRole("columnheader", { name: /capacity/i });
    expect(capHeader).toHaveAttribute("aria-sort", "descending");
  });
});
