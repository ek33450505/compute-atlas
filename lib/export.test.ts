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

function makeSecondSource() {
  return {
    url: "https://second-example.com",
    label: "Second Example Source",
    retrievedAt: "2024-02-01",
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

// Multiple sources, to exercise source_count and primary_source_url.
const multiSourceFacility: Facility = {
  id: "epsilon-facility",
  name: "Epsilon Center",
  operator: "EpsilonCorp",
  status: "operational",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 33.0, lon: -84.0, city: "Atlanta", state: "GA", precision: "exact" },
  capacityMw: { operational: 75 },
  statusHistory: [],
  sources: [makeSource(), makeSecondSource()],
  lastUpdated: "2024-06-01",
};

// Name/operator that look like spreadsheet formulas, plus a legitimately
// negative lon, to exercise the CSV formula-injection guard.
const formulaInjectionFacility: Facility = {
  id: "zeta-facility",
  name: "=1+1",
  operator: "@SUM(A1:A9)",
  status: "operational",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 29.9511, lon: -90.0148, city: "New Orleans", state: "LA", precision: "exact" },
  capacityMw: { operational: 100 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-07-01",
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

  it("header row ends with source_count then primary_source_url, after detail_url", () => {
    const header = CSV_COLUMNS.map((c) => c.header);
    expect(header.slice(-3)).toEqual(["detail_url", "source_count", "primary_source_url"]);
  });

  it("populates source_count and primary_source_url for a facility with multiple sources", () => {
    const csv = facilitiesToCsv([multiSourceFacility]);
    const header = CSV_COLUMNS.map((c) => c.header);
    const [, row] = csv.split("\r\n");
    const cells = row.split(",");
    const sourceCountIdx = header.indexOf("source_count");
    const primarySourceUrlIdx = header.indexOf("primary_source_url");
    expect(cells[sourceCountIdx]).toBe(String(multiSourceFacility.sources.length));
    expect(cells[primarySourceUrlIdx]).toBe(multiSourceFacility.sources[0].url);
  });

  it("populates source_count as 1 for a facility with a single source", () => {
    const csv = facilitiesToCsv([dataCenterFacility]);
    const header = CSV_COLUMNS.map((c) => c.header);
    const [, row] = csv.split("\r\n");
    const cells = row.split(",");
    const sourceCountIdx = header.indexOf("source_count");
    expect(cells[sourceCountIdx]).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// CSV formula-injection guard (OWASP CSV injection)
// ---------------------------------------------------------------------------

describe("escapeCsvField formula-injection guard", () => {
  it("prefixes a formula-leading name with a single quote", () => {
    const csv = facilitiesToCsv([formulaInjectionFacility]);
    const header = CSV_COLUMNS.map((c) => c.header);
    const [, row] = csv.split("\r\n");
    const cells = row.split(",");
    const nameIdx = header.indexOf("name");
    expect(cells[nameIdx]).toBe("'=1+1");
  });

  it("prefixes an @-leading operator with a single quote", () => {
    const csv = facilitiesToCsv([formulaInjectionFacility]);
    const header = CSV_COLUMNS.map((c) => c.header);
    const [, row] = csv.split("\r\n");
    const cells = row.split(",");
    const operatorIdx = header.indexOf("operator");
    expect(cells[operatorIdx]).toBe("'@SUM(A1:A9)");
  });

  it("leaves a legitimately negative numeric field (lon) unchanged", () => {
    const csv = facilitiesToCsv([formulaInjectionFacility]);
    const header = CSV_COLUMNS.map((c) => c.header);
    const [, row] = csv.split("\r\n");
    const cells = row.split(",");
    const lonIdx = header.indexOf("lon");
    expect(cells[lonIdx]).toBe("-90.0148");
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
