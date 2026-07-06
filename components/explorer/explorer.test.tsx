import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { Explorer } from "./explorer";
import type { Facility } from "@/lib/schema";

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

const facilityC: Facility = {
  id: "fac-c",
  name: "Gamma Hub",
  operator: "GammaTech",
  status: "under_construction",
  aiClassification: "confirmed",
  confidence: "rumored",
  location: { lat: 38.0, lon: -77.0, city: "Reston", state: "VA" },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2025-01-15",
};

const facilityD: Facility = {
  id: "fac-d",
  name: "Delta Node",
  operator: "DeltaLLC",
  status: "cancelled",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 40.0, lon: -74.0, city: "Newark", state: "NJ" },
  capacityMw: { operational: 50 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2023-12-01",
};

const fixtures: Facility[] = [facilityA, facilityB, facilityC, facilityD];

// ---------------------------------------------------------------------------
// Helper — render in table view (jsdom can't render WebGL map)
// ---------------------------------------------------------------------------

function renderExplorer(searchParams?: Record<string, string>) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams ?? { view: "table" }}>
      <Explorer facilities={fixtures} />
    </NuqsTestingAdapter>
  );
}

// ---------------------------------------------------------------------------
// Result count
// ---------------------------------------------------------------------------

describe("Explorer — result count", () => {
  it("shows correct count for all facilities in table view", () => {
    renderExplorer();
    expect(
      screen.getByRole("status")
    ).toHaveTextContent("Showing 4 of 4 facilities");
  });
});

// ---------------------------------------------------------------------------
// View toggle aria-pressed
// ---------------------------------------------------------------------------

describe("Explorer — view toggle", () => {
  it("Map view button has aria-pressed=false in table view", () => {
    renderExplorer({ view: "table" });
    const mapBtn = screen.getByRole("button", { name: "Map view" });
    expect(mapBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("Table view button has aria-pressed=true in table view", () => {
    renderExplorer({ view: "table" });
    const tableBtn = screen.getByRole("button", { name: "Table view" });
    expect(tableBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("toggling to table view renders table rows", async () => {
    renderExplorer({ view: "table" });
    // All 4 fixtures should produce rows (1 header + 4 data = 5 rows)
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Status checkbox filter
// ---------------------------------------------------------------------------

describe("Explorer — status filter", () => {
  it("checking Operational status reduces displayed rows", async () => {
    const user = userEvent.setup();
    renderExplorer({ view: "table" });

    // Initially 4 data rows
    let rows = screen.getAllByRole("row");
    expect(rows.length).toBe(5); // 1 header + 4 data

    // Find and click the Operational status checkbox
    const operationalCheckbox = screen.getByRole("checkbox", {
      name: "Operational",
    });
    await user.click(operationalCheckbox);

    // Count should update — only 1 operational facility
    rows = screen.getAllByRole("row");
    expect(rows.length).toBe(2); // 1 header + 1 data

    // Result count live region should update
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing 1 of 4 facilities"
    );
  });
});

// ---------------------------------------------------------------------------
// Clear all
// ---------------------------------------------------------------------------

describe("Explorer — clear all", () => {
  it("Clear all button appears when a status filter is active", async () => {
    const user = userEvent.setup();
    renderExplorer({ view: "table" });

    // No active filters → Clear all should not exist
    expect(
      screen.queryByRole("button", { name: /clear all/i })
    ).not.toBeInTheDocument();

    // Activate a filter
    const operationalCheckbox = screen.getByRole("checkbox", {
      name: "Operational",
    });
    await user.click(operationalCheckbox);

    // Clear all should appear
    const clearBtn = screen.getByRole("button", { name: /clear all/i });
    expect(clearBtn).toBeInTheDocument();
  });

  it("Clear all resets filters and restores all rows", async () => {
    const user = userEvent.setup();
    renderExplorer({ view: "table" });

    // Activate a filter
    const operationalCheckbox = screen.getByRole("checkbox", {
      name: "Operational",
    });
    await user.click(operationalCheckbox);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing 1 of 4 facilities"
    );

    // Clear all
    const clearBtn = screen.getByRole("button", { name: /clear all/i });
    await user.click(clearBtn);

    // All 4 facilities restored
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing 4 of 4 facilities"
    );
    expect(
      screen.queryByRole("button", { name: /clear all/i })
    ).not.toBeInTheDocument();
  });
});
