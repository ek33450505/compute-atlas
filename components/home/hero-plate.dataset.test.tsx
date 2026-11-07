import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HeroPlate } from "./hero-plate";
import { HERO_PLATE } from "./hero-plate-paths";
import { isTerritoryCode, stateNameFromCode } from "@/lib/us-states";

// Real-dataset invariants (DATASET=real, npm run test:dataset). The default run
// uses the 68-record fixture snapshot, which omits nothing, so these
// preconditions cannot hold there.

const nf = new Intl.NumberFormat("en-US");
const expectedTotal = nf.format(HERO_PLATE.total);

describe("HeroPlate — against the real dataset", () => {
  it("claims only what it draws — not the full dataset total", () => {
    // Precondition: with nothing omitted the two figures coincide and this
    // assertion could not fail, so state it rather than assume it.
    expect(HERO_PLATE.omitted).toBeGreaterThan(0);

    render(<HeroPlate />);
    const name = screen.getByRole("img").getAttribute("aria-label") ?? "";

    expect(name).not.toContain(expectedTotal);
  });

  // The provenance rule renders the literal phrase "in U.S. territories".
  // Nothing else checks that the claim is TRUE of the data, so this does — a
  // wave that omitted a non-territory jurisdiction would make that visible text
  // false.
  it("omits only real US territories, the claim hero-provenance.tsx renders", () => {
    expect(HERO_PLATE.omitted).toBeGreaterThan(0);
    expect(HERO_PLATE.omittedJurisdictions.length).toBeGreaterThan(0);

    for (const code of HERO_PLATE.omittedJurisdictions) {
      expect(isTerritoryCode(code)).toBe(true);
      expect(stateNameFromCode(code)).toBeDefined();
    }
  });
});
