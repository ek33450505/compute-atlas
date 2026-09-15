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

  it("opens the lead paragraph with a versal, on a letter and with room for it", () => {
    render(<CostLedger {...BASE_PROPS} />);

    const lead = screen.getByText(/^Of the generation being built/);
    expect(lead).toHaveClass("drop-cap");
    // `.drop-cap` is a ::first-letter rule setting a 3.1em initial on a 0.72
    // line-height. At the default 1.5 leading it crowds the lines it floats
    // beside, so the only other versal on the site (app/about/page.tsx) pairs
    // it with leading-relaxed; this one must not drift from that.
    expect(lead).toHaveClass("leading-relaxed");
    // ::first-letter absorbs punctuation preceding the first letter and will
    // happily set a digit, so the copy itself is part of the contract: this
    // paragraph has to OPEN on a letter, not on a formatPower interpolation.
    // That contract is enforced by the `getByText(/^Of the generation/)` query
    // above (and the verbatim-copy assertion in the first test), both of which
    // throw the moment the paragraph is rewritten to open on something else.
    // A separate `lead.textContent?.[0]` check used to sit here; it could not
    // fail independently of that query, so it was removed rather than left as
    // an assertion indistinguishable from one that cannot fail.
  });

  it("renders the section heading at the homepage's louder display step", () => {
    render(<CostLedger {...BASE_PROPS} />);

    const heading = screen.getByRole("heading", {
      level: 2,
      name: "The other side of the ledger",
    });
    // Migrated onto SectionHeading size="lg" in the type pass — previously a
    // hand-rolled `mt-1 font-display text-2xl` pair duplicated in four
    // homepage components.
    expect(heading).toHaveClass("text-3xl", "sm:text-4xl");
    expect(heading).not.toHaveClass("text-2xl");
    expect(screen.getByText("§ What it takes")).toBeInTheDocument();
  });

  it("puts real space between the heading block and the stat row", () => {
    const { container } = render(<CostLedger {...BASE_PROPS} />);

    // The heading wrapper carried NO bottom margin and SurveyStatRow carries no
    // top margin of its own, so at size="lg" the 4xl figures sat directly under
    // the h2 on a 390px phone (Ed, iPhone QA, 2026-09-15). jsdom computes no
    // layout, so the class is the only observable — but the gap has to live on
    // THIS element: SurveyStatRow accepts no className and its own class string
    // is pinned by a regression test across fourteen call sites.
    const headingBlock = container.querySelector(".space-y-1");
    expect(headingBlock).toHaveClass("mb-6");
    expect(headingBlock?.querySelector("h2")).toHaveAttribute(
      "id",
      "cost-ledger-heading"
    );
  });

  // A <section> is only exposed as an accessible "region" when it HAS a name,
  // so querying by role+name proves the section's aria-labelledby actually
  // resolves to the h2's id. SectionHeading deliberately leaves that pairing to
  // the caller (see its `id` doc comment), which is exactly the contract that
  // can break silently — move the id onto the wrapper div and every other
  // assertion in this file stays green while the landmark goes unnamed. Same
  // form as lens-gateway.test.tsx.
  it("renders as a labeled region and passes className through to it", () => {
    render(<CostLedger {...BASE_PROPS} className="mt-12 border-t pt-10" />);

    const section = screen.getByRole("region", {
      name: "The other side of the ledger",
    });
    expect(section).toHaveClass("mt-12", "border-t", "pt-10");
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
