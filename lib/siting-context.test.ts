import { describe, it, expect } from "vitest";
import facilitiesRaw from "@/data/facilities.json";
import sitingContextRaw from "@/data/siting-context.json";
import { splitRiskLabel } from "./siting-context";

describe("splitRiskLabel", () => {
  it("splits a label with a trailing parenthetical detail", () => {
    expect(splitRiskLabel("Extremely High (>80%)")).toEqual({
      category: "Extremely High",
      detail: ">80%",
    });
  });

  it("splits a label with a hyphenated range detail", () => {
    expect(splitRiskLabel("High (4-8 cm/y)")).toEqual({
      category: "High",
      detail: "4-8 cm/y",
    });
  });

  it("returns no detail when the label has no parenthetical", () => {
    expect(splitRiskLabel("Extremely High")).toEqual({
      category: "Extremely High",
    });
  });

  it("trims surrounding whitespace from category and detail", () => {
    expect(splitRiskLabel("  Medium  ( 20-40% ) ")).toEqual({
      category: "Medium",
      detail: "20-40%",
    });
  });
});

describe("data-integrity: siting-context coverage", () => {
  // Only forward coverage (facility -> siting entry) is asserted here.
  // The reverse is expected and legitimate: retiring a facility requires a
  // raw Neon delete (see CLAUDE.md) that leaves a stale siting-context entry
  // behind on purpose. Do NOT add an orphan-entry assertion — that would
  // break retirements, not catch a real bug.
  it("has a data/siting-context.json entry for every facility in data/facilities.json", () => {
    const sitingIds = new Set(Object.keys(sitingContextRaw));
    const missingIds = (facilitiesRaw as Array<{ id: string }>)
      .map((facility) => facility.id)
      .filter((id) => !sitingIds.has(id));

    if (missingIds.length > 0) {
      const shown = missingIds.slice(0, 20);
      const more = missingIds.length - shown.length;
      const suffix = more > 0 ? `, and ${more} more` : "";
      throw new Error(
        `${missingIds.length} facilit${missingIds.length === 1 ? "y is" : "ies are"} missing ` +
          `from data/siting-context.json: ${shown.join(", ")}${suffix}. ` +
          "This happens when a data wave runs db:export but skips `npm run build:mapdata` " +
          "before committing. Run `npm run build:mapdata` and commit the regenerated " +
          "data/siting-context.json.",
      );
    }

    expect(missingIds).toEqual([]);
  });
});
