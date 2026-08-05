import { describe, it, expect } from "vitest";

import {
  DROUGHT_RAMP,
  FILL_ONLY_OVERLAY_IDS,
  GROUNDWATER_RAMP,
  WATER_STRESS_RAMP,
  colorForGroundwaterLabel,
  colorForWaterStressLabel,
  orderedGroundwaterDistribution,
  orderedWaterStressDistribution,
} from "./map-overlays";

describe("colorForWaterStressLabel", () => {
  it("maps the most severe label to the darkest ramp color", () => {
    expect(colorForWaterStressLabel("Extremely High (>80%)")).toBe(
      WATER_STRESS_RAMP[WATER_STRESS_RAMP.length - 1]
    );
  });

  it("maps the least severe label to the lightest ramp color", () => {
    expect(colorForWaterStressLabel("Low (<10%)")).toBe(WATER_STRESS_RAMP[0]);
  });

  it("is case/whitespace insensitive", () => {
    expect(colorForWaterStressLabel("  extremely high (>80%)  ")).toBe(
      WATER_STRESS_RAMP[WATER_STRESS_RAMP.length - 1]
    );
  });

  it("returns undefined for an unrecognized label rather than throwing", () => {
    expect(colorForWaterStressLabel("Not A Real Band")).toBeUndefined();
  });
});

describe("colorForGroundwaterLabel", () => {
  it("maps the most severe label present in the sample data to the second-darkest ramp color (cat 4 'Extremely High' is 0-count and absent from the sample)", () => {
    expect(colorForGroundwaterLabel("High (4-8 cm/y)")).toBe(
      GROUNDWATER_RAMP[GROUNDWATER_RAMP.length - 2]
    );
  });

  it("maps the least severe label to the lightest ramp color", () => {
    expect(colorForGroundwaterLabel("Low (<0 cm/y)")).toBe(GROUNDWATER_RAMP[0]);
  });

  it("returns undefined for an unrecognized label rather than throwing", () => {
    expect(colorForGroundwaterLabel("Not A Real Band")).toBeUndefined();
  });
});

describe("orderedWaterStressDistribution", () => {
  it("orders known bands most-severe-first and preserves counts", () => {
    const distribution = {
      "Low (<10%)": 232,
      "Extremely High (>80%)": 126,
      "High (40-80%)": 162,
    };

    const ordered = orderedWaterStressDistribution(distribution);

    expect(ordered.map((entry) => entry.label)).toEqual([
      "Extremely High (>80%)",
      "High (40-80%)",
      "Low (<10%)",
    ]);
    expect(ordered.find((entry) => entry.label === "Extremely High (>80%)")?.count).toBe(126);
  });

  it("appends unrecognized labels at the end instead of dropping them", () => {
    const distribution = {
      "Extremely High (>80%)": 126,
      "Some New Band": 5,
    };

    const ordered = orderedWaterStressDistribution(distribution);

    expect(ordered.map((entry) => entry.label)).toEqual(["Extremely High (>80%)", "Some New Band"]);
  });
});

describe("orderedGroundwaterDistribution", () => {
  it("orders known bands most-severe-first and preserves counts", () => {
    const distribution = {
      "Low - Medium (0-2 cm/y)": 180,
      "High (4-8 cm/y)": 52,
      "Medium - High (2-4 cm/y)": 19,
      "Low (<0 cm/y)": 1,
    };

    const ordered = orderedGroundwaterDistribution(distribution);

    expect(ordered.map((entry) => entry.label)).toEqual([
      "High (4-8 cm/y)",
      "Medium - High (2-4 cm/y)",
      "Low - Medium (0-2 cm/y)",
      "Low (<0 cm/y)",
    ]);
  });
});

describe("FILL_ONLY_OVERLAY_IDS", () => {
  it("lists exactly the three pure-fill overlays hidden on satellite", () => {
    expect(FILL_ONLY_OVERLAY_IDS).toEqual(["waterStress", "groundwater", "drought"]);
  });
});

describe("ramps", () => {
  it("water-stress, groundwater, and drought ramps each have 5 severity steps", () => {
    expect(WATER_STRESS_RAMP).toHaveLength(5);
    expect(GROUNDWATER_RAMP).toHaveLength(5);
    expect(DROUGHT_RAMP).toHaveLength(5);
  });
});
