import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { StackedBand, type StackedBandSegment } from "./stacked-band";

// The real six-band water-stress histogram from public/data/map-layers.json,
// with the colors lib/map-overlays.ts assigns it (note "Arid and Low Water
// Use" shares the lightest ramp entry with "Low (<10%)" — six labels over a
// five-color ramp, which is why the label text, never the swatch, is the
// channel that has to disambiguate).
const WATER_STRESS: StackedBandSegment[] = [
  { label: "Extremely High (>80%)", count: 253, color: "#1E4E6B" },
  { label: "High (40-80%)", count: 348, color: "#4A80A0" },
  { label: "Medium - High (20-40%)", count: 443, color: "#7CA9C0" },
  { label: "Low - Medium (10-20%)", count: 296, color: "#AFCBDC" },
  { label: "Low (<10%)", count: 557, color: "#DCEAF2" },
  { label: "Arid and Low Water Use", count: 17, color: "#DCEAF2" },
];

const BASE_PROPS = {
  title: "Baseline water stress",
  ariaLabel: "Baseline water stress of 1,914 sites, most severe band first.",
  tableCaption: "Sites by baseline water-stress band, most severe first",
  countHeading: "Sites",
  segments: WATER_STRESS,
};

/** Reads the percentage cell (last column) of every data row. */
function renderedShares(): number[] {
  return within(screen.getByRole("table"))
    .getAllByRole("rowheader")
    .map((header) => {
      const cells = within(header.closest("tr") as HTMLElement).getAllByRole("cell");
      return Number.parseFloat(cells[cells.length - 1].textContent ?? "");
    });
}

/**
 * Asserts every drawn segment still carries a usable `flex-grow`.
 *
 * Phrased as a positive assertion, not as "the style attribute contains no
 * NaN/Infinity" — that form CANNOT FAIL. jsdom (like a browser) silently
 * *discards* `flex-grow: Infinity` as an invalid declaration, so the poisoned
 * value never appears in the attribute to be matched against; the segment just
 * falls back to `flex-grow: 0` and the rail collapses. Checking that the
 * declaration is present and finite is the only form that detects that.
 */
function expectDrawableGeometry(band: HTMLElement): void {
  for (const segment of Array.from(band.children)) {
    const grow = Number.parseFloat((segment as HTMLElement).style.flexGrow);
    expect(Number.isFinite(grow)).toBe(true);
    expect(grow).toBeGreaterThan(0);
  }
}

describe("StackedBand", () => {
  it("names every band in text, adjacent to its swatch, so color is never the only channel", () => {
    render(<StackedBand {...BASE_PROPS} />);

    const rowHeaders = within(screen.getByRole("table")).getAllByRole("rowheader");
    expect(rowHeaders).toHaveLength(WATER_STRESS.length);

    WATER_STRESS.forEach(({ label, color }, index) => {
      const header = rowHeaders[index];
      // Half the claim: the band is named in real text, in its own row.
      expect(within(header).getByText(label)).toBeInTheDocument();
      // The other half, which the name asserts and the text alone cannot:
      // a swatch is actually painted beside that text. Without this, deleting
      // the swatch element entirely leaves the test green.
      const swatch = header.querySelector('[aria-hidden="true"]');
      expect(swatch).not.toBeNull();
      // `toHaveStyle` normalizes both sides, so the hex literal from the ramp
      // compares equal to jsdom's `rgb(...)`.
      expect(swatch).toHaveStyle({ backgroundColor: color });
    });
  });

  it("gives the graphic a meaningful accessible name and hides its segments from assistive tech", () => {
    render(<StackedBand {...BASE_PROPS} />);

    const band = screen.getByRole("img", {
      name: "Baseline water stress of 1,914 sites, most severe band first.",
    });
    expect(band).toBeInTheDocument();
    expect(band.children).toHaveLength(WATER_STRESS.length);
    for (const segment of Array.from(band.children)) {
      expect(segment).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("carries every band's count and share in a real table, captioned for screen readers", () => {
    render(<StackedBand {...BASE_PROPS} />);

    const table = screen.getByRole("table", {
      name: "Sites by baseline water-stress band, most severe first",
    });
    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders).toHaveLength(WATER_STRESS.length);

    // Counts are grouped ("1,914"-style) and paired with the right band.
    const extremelyHighRow = rowHeaders[0].closest("tr") as HTMLElement;
    expect(within(extremelyHighRow).getByText("253")).toBeInTheDocument();
    expect(within(extremelyHighRow).getByText("13.2%")).toBeInTheDocument();

    const lowRow = rowHeaders[4].closest("tr") as HTMLElement;
    expect(within(lowRow).getByText("557")).toBeInTheDocument();

    expect(within(table).getByRole("columnheader", { name: "Sites" })).toBeInTheDocument();
  });

  it("partitions the rail with flex-grow rather than rounded widths, so no hairline gap is left", () => {
    render(<StackedBand {...BASE_PROPS} />);

    const band = screen.getByRole("img", { name: BASE_PROPS.ariaLabel });
    const grows = Array.from(band.children).map(
      (segment) => (segment as HTMLElement).style.flexGrow
    );
    expect(grows).toEqual(["253", "348", "443", "296", "557", "17"]);
    // No segment is laid out from a rounded percentage width.
    for (const segment of Array.from(band.children)) {
      expect((segment as HTMLElement).style.width).toBe("");
    }
  });

  it("keeps the thinnest band visible instead of letting it round away to nothing", () => {
    render(<StackedBand {...BASE_PROPS} />);

    const band = screen.getByRole("img", { name: BASE_PROPS.ariaLabel });
    // "Arid and Low Water Use" is 17 of 1,914 — about 0.9%.
    const arid = band.children[5] as HTMLElement;
    expect(arid.style.minWidth).toBe("2px");
  });

  it("renders the caption as visible text (the CC-BY attribution's home)", () => {
    render(
      <StackedBand
        {...BASE_PROPS}
        caption="Map-overlay snapshot, not the live count · WRI Aqueduct 4.0 (CC BY 4.0)"
      />
    );

    expect(
      screen.getByText(
        "Map-overlay snapshot, not the live count · WRI Aqueduct 4.0 (CC BY 4.0)"
      )
    ).toBeInTheDocument();
  });

  it("renders the caller-composed title and value line", () => {
    render(<StackedBand {...BASE_PROPS} valueLabel="1,914 sites · map snapshot" />);

    expect(screen.getByText("Baseline water stress")).toBeInTheDocument();
    expect(screen.getByText("1,914 sites · map snapshot")).toBeInTheDocument();
  });

  describe("degenerate inputs", () => {
    it("renders nothing at all for a zero total, rather than dividing by zero", () => {
      const { container } = render(
        <StackedBand
          {...BASE_PROPS}
          segments={[
            { label: "Low (<10%)", count: 0, color: "#DCEAF2" },
            { label: "High (40-80%)", count: 0, color: "#4A80A0" },
          ]}
        />
      );

      expect(container).toBeEmptyDOMElement();
      expect(container.textContent ?? "").not.toContain("NaN");
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("renders nothing for an empty segment list", () => {
      const { container } = render(<StackedBand {...BASE_PROPS} segments={[]} />);
      expect(container).toBeEmptyDOMElement();
    });

    it("gives a single band the whole rail at 100%", () => {
      render(
        <StackedBand
          {...BASE_PROPS}
          segments={[{ label: "Low (<10%)", count: 42, color: "#DCEAF2" }]}
        />
      );

      const band = screen.getByRole("img", { name: BASE_PROPS.ariaLabel });
      expect(band.children).toHaveLength(1);
      expect(screen.getByText("100.0%")).toBeInTheDocument();
    });

    it("recomputes shares from the bands it was given when one is absent — no empty segment, no 'undefined', no stale total", () => {
      // Five of the six bands: "Arid and Low Water Use" is simply missing
      // from the distribution, exactly as map-layers.json omits a band with
      // no facilities in it.
      const fiveOfSix = WATER_STRESS.slice(0, 5);
      render(<StackedBand {...BASE_PROPS} segments={fiveOfSix} />);

      const band = screen.getByRole("img", { name: BASE_PROPS.ariaLabel });
      expect(band.children).toHaveLength(5);

      const table = screen.getByRole("table");
      expect(within(table).getAllByRole("rowheader")).toHaveLength(5);
      expect(screen.queryByText("Arid and Low Water Use")).not.toBeInTheDocument();

      const text = document.body.textContent ?? "";
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");

      // The shares are against 1,897 — the five bands present — not against
      // the artifact's own 1,914 total.
      const shares = renderedShares();
      expect(shares).toHaveLength(5);
      const sum = shares.reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThan(99.5);
      expect(sum).toBeLessThan(100.5);
      expect(shares[0]).toBeCloseTo((253 / 1897) * 100, 1);
    });

    it("keeps a present-but-zero band in the table as a finding, but draws no segment for it", () => {
      render(
        <StackedBand
          {...BASE_PROPS}
          segments={[
            { label: "Extremely High (>80%)", count: 0, color: "#1E4E6B" },
            { label: "Low (<10%)", count: 10, color: "#DCEAF2" },
          ]}
        />
      );

      const band = screen.getByRole("img", { name: BASE_PROPS.ariaLabel });
      expect(band.children).toHaveLength(1);

      const table = screen.getByRole("table");
      const rowHeaders = within(table).getAllByRole("rowheader");
      expect(rowHeaders).toHaveLength(2);
      const zeroRow = rowHeaders[0].closest("tr") as HTMLElement;
      expect(within(zeroRow).getByText("0")).toBeInTheDocument();
      expect(within(zeroRow).getByText("0.0%")).toBeInTheDocument();
    });

    it("clamps a negative count to zero instead of inverting the band", () => {
      render(
        <StackedBand
          {...BASE_PROPS}
          segments={[
            { label: "Extremely High (>80%)", count: -5, color: "#1E4E6B" },
            { label: "Low (<10%)", count: 10, color: "#DCEAF2" },
          ]}
        />
      );

      const shares = renderedShares();
      expect(shares).toEqual([0, 100]);
    });

    it("falls back to a neutral fill for a band whose label has no ramp entry, rather than dropping it", () => {
      render(
        <StackedBand
          {...BASE_PROPS}
          segments={[
            { label: "Renamed Upstream", count: 5 },
            { label: "Low (<10%)", count: 5, color: "#DCEAF2" },
          ]}
        />
      );

      expect(screen.getByText("Renamed Upstream")).toBeInTheDocument();
      const band = screen.getByRole("img", { name: BASE_PROPS.ariaLabel });
      expect(band.children).toHaveLength(2);
      // Pinned, not merely non-empty: `.not.toBe("")` passed for any colour at
      // all, including one accidentally inherited from the neighbouring band.
      expect((band.children[0] as HTMLElement).style.backgroundColor).toBe(
        "var(--muted-foreground)"
      );
      // The legend swatch degrades to the same neutral, so the two channels
      // still agree about which band is the unrecognized one.
      const renamedHeader = within(screen.getByRole("table")).getAllByRole(
        "rowheader"
      )[0];
      expect(
        (renamedHeader.querySelector('[aria-hidden="true"]') as HTMLElement).style
          .backgroundColor
      ).toBe("var(--muted-foreground)");
    });

    it("clamps a NaN count to zero instead of letting it defeat the zero guard and print 'NaN%'", () => {
      const { container } = render(
        <StackedBand
          {...BASE_PROPS}
          segments={[
            { label: "Extremely High (>80%)", count: Number.NaN, color: "#1E4E6B" },
            { label: "Low (<10%)", count: 10, color: "#DCEAF2" },
          ]}
        />
      );

      // `Math.max(0, NaN)` is NaN, so the total was NaN, `total === 0` was
      // false, and every share divided by NaN.
      expect(container.textContent ?? "").not.toContain("NaN");
      expect(renderedShares()).toEqual([0, 100]);
      expectDrawableGeometry(screen.getByRole("img", { name: BASE_PROPS.ariaLabel }));
    });

    it("clamps an infinite count to zero instead of drawing an unbounded segment", () => {
      const { container } = render(
        <StackedBand
          {...BASE_PROPS}
          segments={[
            {
              label: "Extremely High (>80%)",
              count: Number.POSITIVE_INFINITY,
              color: "#1E4E6B",
            },
            { label: "Low (<10%)", count: 10, color: "#DCEAF2" },
          ]}
        />
      );

      const text = container.textContent ?? "";
      // Infinity survived the clamp: it drew a segment with `flexGrow: Infinity`,
      // rendered its count as "∞", and made its own share Infinity/Infinity.
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("∞");
      expect(renderedShares()).toEqual([0, 100]);

      const band = screen.getByRole("img", { name: BASE_PROPS.ariaLabel });
      expect(band.children).toHaveLength(1);
      expectDrawableGeometry(band);
    });

    it("clamps a null, an absent, or a stringly-typed count the same way — the prop type is not a runtime gate", () => {
      // `segments` is often built from imported JSON, whose element type is
      // inferred rather than checked against StackedBandSegment, so a value
      // the prop type forbids can still arrive at runtime.
      const untyped = (count: unknown) => count as number;

      const { container } = render(
        <StackedBand
          {...BASE_PROPS}
          segments={[
            { label: "Extremely High (>80%)", count: untyped(null), color: "#1E4E6B" },
            { label: "High (40-80%)", count: untyped(undefined), color: "#4A80A0" },
            { label: "Medium - High (20-40%)", count: untyped("7"), color: "#7CA9C0" },
            { label: "Low (<10%)", count: 10, color: "#DCEAF2" },
          ]}
        />
      );

      const text = container.textContent ?? "";
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("null");
      // The numeric string is dropped rather than coerced: it is out of
      // contract, so it must not silently join the denominator.
      expect(renderedShares()).toEqual([0, 0, 0, 100]);
      expectDrawableGeometry(screen.getByRole("img", { name: BASE_PROPS.ariaLabel }));
    });

    it("renders nothing when every count is non-finite, rather than an empty rail", () => {
      const { container } = render(
        <StackedBand
          {...BASE_PROPS}
          segments={[
            { label: "Low (<10%)", count: Number.NaN, color: "#DCEAF2" },
            { label: "High (40-80%)", count: Number.POSITIVE_INFINITY, color: "#4A80A0" },
          ]}
        />
      );

      expect(container).toBeEmptyDOMElement();
    });
  });

  it("renders shares that sum to 100 within the ±0.5 rounding tolerance of six one-decimal values", () => {
    render(<StackedBand {...BASE_PROPS} />);

    const shares = renderedShares();
    expect(shares).toHaveLength(6);
    for (const share of shares) {
      expect(Number.isNaN(share)).toBe(false);
    }
    const sum = shares.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(99.5);
    expect(sum).toBeLessThan(100.5);
  });
});
