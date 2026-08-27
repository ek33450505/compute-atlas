import { describe, it, expect } from "vitest";
import {
  GENERATION_TECHNOLOGY_ORDER,
  GENERATION_TECHNOLOGY_LABELS,
  getGenerationTechnologyLabel,
  GENERATION_FUEL_CLASS,
  getGenerationFuelClass,
} from "./generation";

describe("GENERATION_TECHNOLOGY_ORDER", () => {
  it("has exactly 10 entries", () => {
    expect(GENERATION_TECHNOLOGY_ORDER).toHaveLength(10);
  });
});

describe("GENERATION_TECHNOLOGY_LABELS", () => {
  it("every technology has a non-empty label", () => {
    for (const tech of GENERATION_TECHNOLOGY_ORDER) {
      expect(GENERATION_TECHNOLOGY_LABELS[tech]).toBeTruthy();
    }
  });
});

describe("getGenerationTechnologyLabel", () => {
  it("returns the exact label for nuclear_smr", () => {
    expect(getGenerationTechnologyLabel("nuclear_smr")).toBe("Nuclear · SMR");
  });

  it("returns the exact label for fusion", () => {
    expect(getGenerationTechnologyLabel("fusion")).toBe("Fusion");
  });

  it("returns the fallback for undefined", () => {
    expect(getGenerationTechnologyLabel(undefined)).toBe("Technology unknown");
  });
});

describe("GENERATION_FUEL_CLASS", () => {
  it("every one of the 10 enum keys has a fuel class", () => {
    for (const tech of GENERATION_TECHNOLOGY_ORDER) {
      expect(["fossil", "non_fossil", "unclassified"]).toContain(
        GENERATION_FUEL_CLASS[tech]
      );
    }
  });

  it("natural_gas is the only fossil technology", () => {
    const fossil = GENERATION_TECHNOLOGY_ORDER.filter(
      (tech) => GENERATION_FUEL_CLASS[tech] === "fossil"
    );
    expect(fossil).toEqual(["natural_gas"]);
  });

  it("battery and other are unclassified", () => {
    expect(GENERATION_FUEL_CLASS.battery).toBe("unclassified");
    expect(GENERATION_FUEL_CLASS.other).toBe("unclassified");
  });

  it("every remaining technology is non_fossil", () => {
    const nonFossil = GENERATION_TECHNOLOGY_ORDER.filter(
      (tech) => GENERATION_FUEL_CLASS[tech] === "non_fossil"
    );
    expect(nonFossil).toEqual([
      "nuclear_smr",
      "nuclear",
      "fusion",
      "solar",
      "wind",
      "hydro",
      "geothermal",
    ]);
  });
});

describe("getGenerationFuelClass", () => {
  it("returns unclassified for undefined", () => {
    expect(getGenerationFuelClass(undefined)).toBe("unclassified");
  });

  it("matches GENERATION_FUEL_CLASS for every defined technology", () => {
    for (const tech of GENERATION_TECHNOLOGY_ORDER) {
      expect(getGenerationFuelClass(tech)).toBe(GENERATION_FUEL_CLASS[tech]);
    }
  });
});
