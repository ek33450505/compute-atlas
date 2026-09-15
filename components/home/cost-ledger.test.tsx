import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import mapLayers from "@/public/data/map-layers.json";
import { CostLedger } from "./cost-ledger";

const BASE_PROPS = {
  fossilPlannedMw: 69203,
  nonFossilPlannedMw: 19372,
  gasNotYetBuilt: 65,
  gasTotal: 80,
  waterStressRated: 1651,
  waterStressHighOrExtreme: 549,
};

describe("CostLedger", () => {
  it("renders the heading and both prose paragraphs with injected figures", () => {
    render(<CostLedger {...BASE_PROPS} />);

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "The other side of the ledger",
      })
    ).toBeInTheDocument();

    expect(
      screen.getByText(
        "Of the generation being built specifically to serve compute, 69.2 GW of planned capacity is natural gas, against 19.4 GW for every non-fossil technology combined. 65 of the 80 tracked gas plants are not built yet — the most carbon-intensive option on the table is still the one being chosen, in proceedings that are still open."
      )
    ).toBeInTheDocument();

    expect(screen.getByText(/549 of the 1,651/)).toBeInTheDocument();
  });

  it("renders both links with the right href and a meaningful accessible name", () => {
    render(<CostLedger {...BASE_PROPS} />);

    const powerLink = screen.getByRole("link", { name: "the power buildout" });
    expect(powerLink).toHaveAttribute("href", "/power");

    const waterLink = screen.getByRole("link", {
      name: "how much water data centers use",
    });
    expect(waterLink).toHaveAttribute("href", "/learn/data-center-water-use");
  });

  it("guards the ratio tile against a zero non-fossil denominator", () => {
    render(<CostLedger {...BASE_PROPS} nonFossilPlannedMw={0} />);

    expect(screen.queryByText(/Infinity/)).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("omits the water-stress clause on a zero rated denominator rather than printing '0 of the 0' as a finding", () => {
    const { container } = render(
      <CostLedger
        {...BASE_PROPS}
        waterStressRated={0}
        waterStressHighOrExtreme={0}
      />
    );
    const text = container.textContent ?? "";

    expect(text).not.toContain("NaN");
    expect(text).not.toContain("0 of the 0");
    expect(
      screen.queryByText(/describes the surrounding basin/)
    ).not.toBeInTheDocument();
    // The paragraph still reads as valid English with the clause gone: the
    // links keep their "More on" lead-in rather than dangling on their own.
    expect(text).toContain("More on");
    expect(
      screen.getByRole("link", { name: "the power buildout" })
    ).toBeInTheDocument();
  });

  it("renders the water-stress caveat sentence without asserting a siting bias", () => {
    render(<CostLedger {...BASE_PROPS} />);

    expect(
      screen.getByText(
        /describes the surrounding basin, not any one facility.s measured water use/
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Whether it matters at a given site depends on how that site cools, and most operators do not disclose it/
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/choosing to put itself/)
    ).not.toBeInTheDocument();
  });

  describe("water-stress band", () => {
    const bands = Object.entries(mapLayers.waterStress.distribution);
    const snapshotTotal = bands.reduce((sum, [, count]) => sum + count, 0);

    it("replaces the stressed-basins stat tile with the six-band histogram", () => {
      render(<CostLedger {...BASE_PROPS} />);

      expect(
        screen.queryByText("Sites in stressed basins")
      ).not.toBeInTheDocument();

      const table = screen.getByRole("table");
      expect(within(table).getAllByRole("rowheader")).toHaveLength(bands.length);
      for (const [label] of bands) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    });

    it("carries the WRI Aqueduct CC-BY attribution as visible text, not a comment or a title attribute", () => {
      const { container } = render(<CostLedger {...BASE_PROPS} />);

      const attribution = screen.getByText(/WRI Aqueduct 4\.0 \(CC BY 4\.0\)/);
      expect(attribution).toBeInTheDocument();
      // Visible text, not a tooltip: nothing in the tree stashes it in title=.
      expect(container.querySelector("[title]")).toBeNull();
    });

    it("qualifies the band's snapshot denominator so it cannot be read as the live prose figure", () => {
      render(<CostLedger {...BASE_PROPS} />);

      const snapshotLabel = snapshotTotal.toLocaleString("en-US");
      // The two numbers on screen are 1,914 (build-time snapshot) and 1,651
      // (live Neon). Each states its own basis.
      expect(
        screen.getByText(`${snapshotLabel} sites · map snapshot`)
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Map-overlay snapshot, not the live count/)
      ).toBeInTheDocument();
      expect(screen.getByText(/549 of the 1,651/)).toBeInTheDocument();
    });

    it("describes the band to assistive tech with its own denominator", () => {
      render(<CostLedger {...BASE_PROPS} />);

      const band = screen.getByRole("img", {
        name: new RegExp(
          `Baseline water stress of ${snapshotTotal.toLocaleString("en-US")} sites in the map-overlay snapshot`
        ),
      });
      expect(band).toBeInTheDocument();
    });
  });
});
