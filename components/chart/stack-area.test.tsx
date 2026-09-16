import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { StackArea, type StackAreaBand } from "./stack-area";

// Deliberately synthetic. Every magnitude here is chosen so the three column
// totals DIFFER by a lot (16 · 30 · 77): a 100%-stacked implementation would
// draw all three at the same height, so a fixture with flat totals could not
// tell the two designs apart.
const BANDS: StackAreaBand[] = [
  { label: "Ground", color: "#123456", values: [10, 20, 30] },
  { label: "Middle", color: "#654321", values: [5, 5, 40] },
  { label: "Crown", color: "#abcdef", values: [1, 5, 7] },
];

const X_LABELS = ["P1", "P2", "P3"];

const BASE_PROPS = {
  bands: BANDS,
  xLabels: X_LABELS,
  ariaLabel: "Three bands across three periods. Exact counts follow in the table.",
  tableCaption: "Bands by period",
  xHeading: "Period",
};

/** The drawn bands, bottom of the stack first. */
function polygons(container: HTMLElement): SVGPolygonElement[] {
  return Array.from(container.querySelectorAll("polygon"));
}

/**
 * The y coordinates of a polygon's UPPER edge, left to right.
 *
 * `points` is built as the top edge forward followed by the bottom edge
 * backward, so the first `n` pairs are the upper edge. Parsed rather than
 * matched against a literal string: the assertion is about the SHAPE the
 * geometry describes, not about the formatting of the attribute.
 */
function upperEdgeY(polygon: SVGPolygonElement, n: number): number[] {
  return (polygon.getAttribute("points") ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, n)
    .map((pair) => Number.parseFloat(pair.split(",")[1]));
}

/** Every data row of the `sr-only` table, as `[rowHeader, ...cells]`. */
function tableRows(): string[][] {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("rowheader")
    .map((header) => {
      const row = header.closest("tr") as HTMLElement;
      return [
        header.textContent ?? "",
        ...within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent ?? ""),
      ];
    });
}

describe("StackArea", () => {
  it("exposes the plot as a single named image", () => {
    render(<StackArea {...BASE_PROPS} />);
    expect(
      screen.getByRole("img", { name: /three bands across three periods/i })
    ).toBeInTheDocument();
  });

  it("draws one polygon per band, bottom of the stack first", () => {
    const { container } = render(<StackArea {...BASE_PROPS} />);
    expect(polygons(container).map((p) => p.getAttribute("fill"))).toEqual([
      "#123456",
      "#654321",
      "#abcdef",
    ]);
  });

  /**
   * The load-bearing design assertion: this is a COUNTS chart, not a
   * 100%-stacked one. Under normalisation the top of the stack would sit at
   * the ceiling at every position — identical y for all three — which is
   * exactly what would hide a growing denominator.
   *
   * Mutation-tested: replacing `yAt(value)` with a per-column normalised
   * `yAt(value / totals[i] * max)` makes all three y equal and fails here.
   */
  it("lets the stack's total height track the total, rather than normalising", () => {
    const { container } = render(<StackArea {...BASE_PROPS} />);
    const top = upperEdgeY(polygons(container)[2], X_LABELS.length);

    // SVG y grows downward, so a bigger total means a SMALLER y.
    expect(top[0]).toBeGreaterThan(top[1]);
    expect(top[1]).toBeGreaterThan(top[2]);
    expect(new Set(top).size).toBe(3);
  });

  it("labels the ceiling with the real peak total", () => {
    render(<StackArea {...BASE_PROPS} />);
    // 10+5+1=16, 20+5+5=30, 30+40+7=77 — the peak, not a rounded axis bound.
    // Scoped to the plot: "77" is also a table cell, and an unscoped query
    // would pass on the table alone even with no axis label at all.
    const plot = screen.getByRole("img", { name: /three bands/i });
    expect(within(plot).getByText("77")).toBeInTheDocument();
  });

  it("tabulates every position with per-band counts and a total", () => {
    render(<StackArea {...BASE_PROPS} />);
    expect(tableRows()).toEqual([
      ["P1", "10", "5", "1", "16"],
      ["P2", "20", "5", "5", "30"],
      ["P3", "30", "40", "7", "77"],
    ]);
  });

  it("names the table and its columns", () => {
    render(<StackArea {...BASE_PROPS} />);
    const table = screen.getByRole("table", { name: "Bands by period" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent)
    ).toEqual(["Period", "Ground", "Middle", "Crown", "Total"]);
  });

  it("pairs every legend swatch with its label in text", () => {
    render(<StackArea {...BASE_PROPS} />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Ground",
      "Middle",
      "Crown",
    ]);
  });

  describe("values outside the documented contract", () => {
    it("drops non-finite and negative magnitudes instead of coercing them", () => {
      const { container } = render(
        <StackArea
          {...BASE_PROPS}
          bands={[
            { label: "Ground", color: "#123456", values: [10, 20, 30] },
            {
              label: "Middle",
              color: "#654321",
              values: [Number.NaN, -5, Number.POSITIVE_INFINITY],
            },
            { label: "Crown", color: "#abcdef", values: [1, 5, 7] },
          ]}
        />
      );

      // Positive form, not "the attribute contains no NaN": a poisoned
      // coordinate makes the browser discard the whole `points` list, so the
      // bad value is not there to be matched against — only checking that
      // every coordinate is finite detects it.
      for (const polygon of polygons(container)) {
        const coords = (polygon.getAttribute("points") ?? "")
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        expect(coords.length).toBeGreaterThan(0);
        expect(coords.every(Number.isFinite)).toBe(true);
      }

      expect(tableRows()).toEqual([
        ["P1", "10", "0", "1", "11"],
        ["P2", "20", "0", "5", "25"],
        ["P3", "30", "0", "7", "37"],
      ]);
    });

    it("reads a short values array as zero for the missing tail", () => {
      render(
        <StackArea
          {...BASE_PROPS}
          bands={[{ label: "Ground", color: "#123456", values: [10] }]}
        />
      );
      expect(tableRows()).toEqual([
        ["P1", "10", "10"],
        ["P2", "0", "0"],
        ["P3", "0", "0"],
      ]);
    });

    it("renders nothing when there is no magnitude to picture", () => {
      const { container } = render(
        <StackArea
          {...BASE_PROPS}
          bands={[{ label: "Ground", color: "#123456", values: [0, 0, 0] }]}
        />
      );
      expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing when there are no positions", () => {
      const { container } = render(<StackArea {...BASE_PROPS} xLabels={[]} />);
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe("a provisional period", () => {
    it("keeps it in the data and marks it in the table", () => {
      render(
        <StackArea {...BASE_PROPS} provisionalIndex={2} provisionalNote="in progress" />
      );
      const rows = tableRows();
      expect(rows[2][0]).toBe("P3 (in progress)");
      // Marked, not dropped — the magnitudes are unchanged.
      expect(rows[2].slice(1)).toEqual(["30", "40", "7", "77"]);
    });

    it("marks it visually as well, by a dashed rule", () => {
      const { container } = render(
        <StackArea {...BASE_PROPS} provisionalIndex={2} provisionalNote="in progress" />
      );
      const dashed = Array.from(container.querySelectorAll("line")).filter(
        (line) => line.getAttribute("stroke-dasharray") === "4 3"
      );
      expect(dashed).toHaveLength(1);
    });

    it("ignores an index outside the series rather than drawing a stray rule", () => {
      const { container } = render(
        <StackArea {...BASE_PROPS} provisionalIndex={9} provisionalNote="in progress" />
      );
      expect(
        container.querySelectorAll('line[stroke-dasharray="4 3"]')
      ).toHaveLength(0);
      expect(tableRows()[2][0]).toBe("P3");
    });
  });

  it("renders the caption when one is given, and nothing when not", () => {
    const { rerender } = render(
      <StackArea {...BASE_PROPS} caption="Counts, not shares." />
    );
    expect(screen.getByText("Counts, not shares.")).toBeInTheDocument();

    rerender(<StackArea {...BASE_PROPS} />);
    expect(screen.queryByText("Counts, not shares.")).not.toBeInTheDocument();
  });

  it("steps the caption clear of the legend", () => {
    // Pinned because the obvious "tidy" is to copy stacked-band.tsx's mt-2,
    // where the caption follows a VISIBLE table. Here it follows an sr-only
    // one — zero visual height — so this margin is the entire gap between the
    // caption and the legend, and mt-3 shipped too tight. A class assertion is
    // crude, but it is the only thing that turns that edit red.
    render(<StackArea {...BASE_PROPS} caption="Counts, not shares." />);
    expect(screen.getByText("Counts, not shares.")).toHaveClass("mt-5");

    // The premise the margin above rests on, pinned separately: that margin is
    // the WHOLE legend-to-caption gap only because this table is out of flow.
    // Drop `sr-only` and the table takes real height, the gap stops being this
    // margin, and the visual defect returns — while the mt-5 assertion above
    // stays green throughout. This is the only assertion that catches that.
    expect(screen.getByRole("table")).toHaveClass("sr-only");
  });

  it("ships no dark-mode utilities", () => {
    // Token built at runtime, matching the idiom in app/globals.css.test.ts:
    // that guard scans every tracked file for the literal substring, so
    // writing it out here would make this assertion an offender in its own
    // right. Do not "simplify" it back to a literal or a regex — a plain
    // containment check is all this needs.
    const darkVariant = `${"dark"}:`;
    const { container } = render(<StackArea {...BASE_PROPS} />);
    expect(container.innerHTML).not.toContain(darkVariant);
  });
});
