import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FacilityTable } from "./facility-table";
import type { Facility } from "@/lib/schema";
import { toTableRow } from "@/lib/facility-slim";

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

const facilityDelta: Facility = {
  id: "delta-facility",
  name: "Delta Point",
  operator: "DeltaSystems",
  status: "permitted",
  facilityType: "data_center",
  // no aiClassification
  confidence: "reported",
  location: { lat: 41.0, lon: -87.0, city: "Chicago", state: "IL", precision: "exact" },
  capacityMw: { operational: 75 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-03-10",
};

const base = { sort: "capacity", dir: "desc", onSort: () => {} } as const;

const fixtures = [facilityAlpha, facilityBeta, facilityGamma, facilityDelta].map(toTableRow);

// ---------------------------------------------------------------------------
// Header tests
// ---------------------------------------------------------------------------

describe("FacilityTable — headers", () => {
  it("renders all required column headers", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    expect(screen.getByRole("columnheader", { name: /name/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /operator/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /status/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /type/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /ai class/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /location/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /capacity/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /confidence/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /updated/i })).toBeInTheDocument();
  });

  it("has a caption (visible to assistive tech)", () => {
    const { container } = render(<FacilityTable facilities={fixtures} {...base} />);
    const caption = container.querySelector("caption");
    expect(caption).toBeInTheDocument();
    expect(caption?.textContent).toMatch(/Data centers/i);
  });

  it("insets the scroll region's focus outline so the overflow-hidden frame cannot clip it", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    const region = screen.getByRole("region", { name: /data centers table/i });
    expect(region.parentElement).toHaveClass("overflow-hidden");
    expect(region).toHaveClass(
      "focus-visible:outline-2",
      "focus-visible:-outline-offset-2",
      "focus-visible:outline-ring"
    );
    // A positive offset would put the whole outline outside the clip edge.
    expect(region.className).not.toMatch(/(?:^|\s)focus-visible:outline-offset-/);
  });
});

// ---------------------------------------------------------------------------
// Row content tests
// ---------------------------------------------------------------------------

describe("FacilityTable — row content", () => {
  it("renders a link to /facilities/<id> for each facility name", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    const alphaLink = screen.getByRole("link", { name: "Alpha Center" });
    expect(alphaLink).toHaveAttribute("href", "/facilities/alpha-facility");
  });

  it("renders the StatusBadge label text for each row", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.getByText("Under construction")).toBeInTheDocument();
  });

  it("formats operational capacity correctly", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    expect(screen.getByText("150 MW")).toBeInTheDocument();
  });

  it("formats planned-only capacity with 'planned' suffix", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    expect(screen.getByText("1,200 MW planned")).toBeInTheDocument();
  });

  it("shows em dash for facility with no capacity", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders location as City, State", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    expect(screen.getByText("Memphis, TN")).toBeInTheDocument();
  });

  it("exposes the full location text via title while carrying the truncation class, for long location strings", () => {
    // A standalone render (not `fixtures`) so this doesn't perturb the
    // sort-order/row-count assertions elsewhere in this file, which key off
    // the exact 4-facility fixture set.
    const longLocationFacility: Facility = {
      ...facilityAlpha,
      id: "long-location-facility",
      name: "Long Location Facility",
      location: {
        lat: 45.8,
        lon: -119.7,
        city: "Boardman area (Tower Road)",
        state: "OR",
        precision: "exact",
      },
    };
    render(<FacilityTable facilities={[toTableRow(longLocationFacility)]} {...base} />);

    const locationText = screen.getByText("Boardman area (Tower Road), OR");
    expect(locationText).toHaveAttribute(
      "title",
      "Boardman area (Tower Road), OR"
    );
    expect(locationText).toHaveClass("truncate", "max-w-[180px]");
  });

  it("renders the facility type label", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    expect(screen.getAllByText("Data center").length).toBeGreaterThan(0);
  });

  it("renders the AI classification label and falls back to em dash when absent", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    expect(screen.getAllByText("AI-specific").length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Accessibility: aria-sort (reflects the URL's sort state, passed as props)
// ---------------------------------------------------------------------------

describe("FacilityTable — aria-sort", () => {
  it("marks only the active column, with its direction", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    expect(screen.getByRole("columnheader", { name: /capacity/i })).toHaveAttribute(
      "aria-sort",
      "descending"
    );
    expect(screen.getByRole("columnheader", { name: /name/i })).toHaveAttribute("aria-sort", "none");
  });

  it("reports ascending when dir is asc", () => {
    render(<FacilityTable facilities={fixtures} sort="name" dir="asc" onSort={() => {}} />);
    expect(screen.getByRole("columnheader", { name: /name/i })).toHaveAttribute(
      "aria-sort",
      "ascending"
    );
  });

  it("sortable header button has accessible label", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    const nameHeader = screen.getByRole("columnheader", { name: /name/i });
    expect(within(nameHeader).getByRole("button")).toHaveAttribute("aria-label", "Sort by Name");
  });

  it("every column header is sortable", () => {
    render(<FacilityTable facilities={fixtures} {...base} />);
    screen.getAllByRole("columnheader").forEach((h) => {
      expect(h).toHaveAttribute("aria-sort");
    });
  });
});

// ---------------------------------------------------------------------------
// Sorting interaction — headers report intent; the server sorts
// ---------------------------------------------------------------------------

describe("FacilityTable — sorting", () => {
  it("clicking an inactive text column asks for ascending", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(<FacilityTable facilities={fixtures} sort="capacity" dir="desc" onSort={onSort} />);
    await user.click(screen.getByRole("button", { name: "Sort by Name" }));
    expect(onSort).toHaveBeenCalledWith("name", "asc");
  });

  it("clicking the active column flips its direction", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(<FacilityTable facilities={fixtures} sort="capacity" dir="desc" onSort={onSort} />);
    await user.click(screen.getByRole("button", { name: "Sort by Capacity" }));
    expect(onSort).toHaveBeenCalledWith("capacity", "asc");
  });

  it("clicking Capacity from another column starts descending", async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(<FacilityTable facilities={fixtures} sort="name" dir="asc" onSort={onSort} />);
    await user.click(screen.getByRole("button", { name: "Sort by Capacity" }));
    expect(onSort).toHaveBeenCalledWith("capacity", "desc");
  });

  it("renders rows in the order given, without re-sorting", () => {
    render(<FacilityTable facilities={[...fixtures].reverse()} sort="name" dir="asc" onSort={() => {}} />);
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByRole("link")).toHaveTextContent("Delta Point");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("FacilityTable — empty state", () => {
  it("renders the empty-state message when facilities is empty", () => {
    render(<FacilityTable facilities={[]} {...base} />);
    expect(
      screen.getByText("No facilities match your filters.")
    ).toBeInTheDocument();
  });

  it("renders no data rows when facilities is empty", () => {
    render(<FacilityTable facilities={[]} {...base} />);
    // Only the header row + the single empty-state row should exist
    const rows = screen.getAllByRole("row");
    // 1 header row + 1 empty state row = 2 rows total
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Row order
// ---------------------------------------------------------------------------

describe("FacilityTable — row order", () => {
  it("keeps the given order for the default capacity-desc sort", () => {
    const ordered = ["Beta Farm", "Alpha Center", "Delta Point", "Gamma Hub"]
      .map((n) => fixtures.find((f) => f.name === n)!);
    render(<FacilityTable facilities={ordered} {...base} />);
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByRole("link")).toHaveTextContent("Beta Farm");
    expect(within(rows[4]).getByRole("link")).toHaveTextContent("Gamma Hub");
  });
});
