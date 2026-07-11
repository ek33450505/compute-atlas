import { describe, it, expect } from "vitest";
import {
  GENERATION_TECHNOLOGY_ORDER,
  GENERATION_TECHNOLOGY_LABELS,
  getGenerationTechnologyLabel,
} from "./generation";

describe("GENERATION_TECHNOLOGY_ORDER", () => {
  it("has exactly 9 entries", () => {
    expect(GENERATION_TECHNOLOGY_ORDER).toHaveLength(9);
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

  it("returns the fallback for undefined", () => {
    expect(getGenerationTechnologyLabel(undefined)).toBe("Technology unknown");
  });
});
