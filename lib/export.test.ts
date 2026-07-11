import { describe, it, expect } from "vitest";
import { CSV_COLUMNS, facilitiesToCsv, facilitiesToJson } from "@/lib/export";
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

const dataCenterFacility: Facility = {
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

const powerGenerationFacility: Facility = {
  id: "gamma-plant",
  name: "Gamma Plant",
  operator: "GammaEnergy",
  status: "operational",
  facilityType: "power_generation",
  confidence: "reported",
  location: { lat: 32.0, lon: -95.0, state: "TX", precision: "exact" },
  capacityMw: { operational: 500 },
  generation: { offtaker: "Amazon (AWS)" },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-05-01",
};

// Name and operator each contain a comma AND a double-quote to exercise escaping.
const specialCharFacility: Facility = {
  id: "delta-facility",
  name: 'Delta "Prime", Inc.',
  operator: 'Delta Systems, "West" Division',
  status: "proposed",
  facilityType: "data_center",
  confidence: "rumored",
  location: { lat: 41.0, lon: -87.0, city: "Chicago", state: "IL", precision: "exact" },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-03-10",
};

// ---------------------------------------------------------------------------
// facilitiesToCsv
// ---------------------------------------------------------------------------

describe("facilitiesToCsv", () => {
  it("returns exactly the header row for an empty array", () => {
    expect(facilitiesToCsv([])).toBe(CSV_COLUMNS.map((c) => c.header).join(","));
  });

  it("header row equals CSV_COLUMNS headers joined by comma", () => {
    const csv = facilitiesToCsv([dataCenterFacility]);
    const [header] = csv.split("\r\n");
    expect(header).toBe(CSV_COLUMNS.map((c) => c.header).join(","));
  });

  it("escapes a field containing a comma and a double-quote", () => {
    const csv = facilitiesToCsv([specialCharFacility]);
    const [, row] = csv.split("\r\n");
    expect(row).toContain('"Delta ""Prime"", Inc."');
    expect(row).toContain('"Delta Systems, ""West"" Division"');
  });

  it("populates offtaker for power_generation and leaves ai_classification empty", () => {
    const csv = facilitiesToCsv([powerGenerationFacility]);
    const header = CSV_COLUMNS.map((c) => c.header);
    const [, row] = csv.split("\r\n");
    const cells = row.split(",");
    const offtakerIdx = header.indexOf("offtaker");
    const aiClassIdx = header.indexOf("ai_classification");
    expect(cells[offtakerIdx]).toBe("Amazon (AWS)");
    expect(cells[aiClassIdx]).toBe("");
  });

  it("leaves offtaker empty for a data_center facility", () => {
    const csv = facilitiesToCsv([dataCenterFacility]);
    const header = CSV_COLUMNS.map((c) => c.header);
    const [, row] = csv.split("\r\n");
    const cells = row.split(",");
    const offtakerIdx = header.indexOf("offtaker");
    expect(cells[offtakerIdx]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// facilitiesToJson
// ---------------------------------------------------------------------------

describe("facilitiesToJson", () => {
  it("round-trips a sample array via JSON.parse", () => {
    const sample = [dataCenterFacility, powerGenerationFacility];
    expect(JSON.parse(facilitiesToJson(sample))).toEqual(sample);
  });

  it("returns '[]' for an empty array", () => {
    expect(facilitiesToJson([])).toBe("[]");
  });
});
