import { describe, it, expect } from "vitest";
import { INITIAL_VIEW_STATE, buildMarkerLabel } from "@/lib/map";
import type { Facility } from "@/lib/schema";

// --- Fixtures ---

const facilityFull: Facility = {
  id: "test-colossus",
  name: "Colossus",
  operator: "xAI",
  status: "operational",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: {
    lat: 35.1495,
    lon: -90.049,
    city: "Memphis",
    state: "TN",
    precision: "exact",
  },
  capacityMw: { operational: 150, planned: 300 },
  statusHistory: [],
  sources: [
    {
      url: "https://example.com/source",
      label: "Example Article",
      retrievedAt: "2024-01",
      kind: "press",
    },
  ],
  lastUpdated: "2024-01",
};

const facilityNoCapacity: Facility = {
  id: "test-proposed",
  name: "Proposed Hub",
  operator: "SomeOperator",
  status: "proposed",
  facilityType: "data_center",
  aiClassification: "likely",
  confidence: "rumored",
  location: {
    lat: 40.0,
    lon: -80.0,
    state: "PA",
    precision: "exact",
  },
  statusHistory: [],
  sources: [
    {
      url: "https://example.com/source2",
      label: "Filing",
      retrievedAt: "2024-01",
      kind: "permit",
    },
  ],
  lastUpdated: "2024-01",
};

const facilityPlannedOnly: Facility = {
  ...facilityNoCapacity,
  id: "test-planned",
  name: "Under Construction Site",
  status: "under_construction",
  capacityMw: { planned: 500 },
};

// --- Tests ---

describe("INITIAL_VIEW_STATE", () => {
  it("centers on the contiguous US (longitude ≈ -98.5)", () => {
    expect(INITIAL_VIEW_STATE.longitude).toBeCloseTo(-98.5, 0);
  });

  it("centers on the contiguous US (latitude ≈ 39.5)", () => {
    expect(INITIAL_VIEW_STATE.latitude).toBeCloseTo(39.5, 0);
  });

  it("has a zoom level suitable for a continental US overview (3–5)", () => {
    expect(INITIAL_VIEW_STATE.zoom).toBeGreaterThanOrEqual(3);
    expect(INITIAL_VIEW_STATE.zoom).toBeLessThanOrEqual(5);
  });
});

describe("buildMarkerLabel", () => {
  it("includes the facility name", () => {
    expect(buildMarkerLabel(facilityFull)).toContain("Colossus");
  });

  it("includes the operator", () => {
    expect(buildMarkerLabel(facilityFull)).toContain("xAI");
  });

  it("includes city when present", () => {
    expect(buildMarkerLabel(facilityFull)).toContain("Memphis");
  });

  it("includes the state code", () => {
    expect(buildMarkerLabel(facilityFull)).toContain("TN");
  });

  it("includes the human-readable status label", () => {
    expect(buildMarkerLabel(facilityFull)).toContain("Operational");
  });

  it("includes the human-readable facility-type label", () => {
    expect(buildMarkerLabel(facilityFull)).toContain("Data center");
  });

  it("includes operational capacity when present", () => {
    const label = buildMarkerLabel(facilityFull);
    expect(label).toContain("150");
    expect(label).toContain("MW operational");
  });

  it("does not include planned capacity when operational capacity is present", () => {
    // When both are present, operational takes precedence
    const label = buildMarkerLabel(facilityFull);
    expect(label).not.toContain("MW planned");
  });

  it("falls back to planned capacity when operational is absent", () => {
    const label = buildMarkerLabel(facilityPlannedOnly);
    expect(label).toContain("500");
    expect(label).toContain("MW planned");
  });

  it("omits capacity segment entirely when capacityMw is absent", () => {
    const label = buildMarkerLabel(facilityNoCapacity);
    expect(label).not.toContain("MW");
  });

  it("handles a facility with no city (no 'undefined' in label)", () => {
    const label = buildMarkerLabel(facilityNoCapacity);
    expect(label).not.toContain("undefined");
    expect(label).toContain("PA");
  });

  it("uses — as separator between parts", () => {
    const label = buildMarkerLabel(facilityFull);
    expect(label).toMatch(/—/);
  });
});
