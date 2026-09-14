import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SurveyStatRow } from "./survey-stat-row";

/** The tile is the nearest wrapping div that holds exactly one figure + its caption. */
function tileFor(text: string): HTMLElement {
  const el = screen.getByText(text);
  const tile = el.closest("div");
  if (!tile) throw new Error(`no tile wrapping "${text}"`);
  return tile;
}

describe("SurveyStatRow", () => {
  it("renders one paired tile per stat for 2, 4, and 5 stats", () => {
    for (const n of [2, 4, 5]) {
      const stats = Array.from({ length: n }, (_, i) => ({
        value: `val-${i}`,
        label: `label-${i}`,
      }));
      const { container, unmount } = render(<SurveyStatRow stats={stats} />);

      const row = container.firstElementChild;
      expect(row?.children).toHaveLength(n);

      for (const stat of stats) {
        expect(within(tileFor(stat.value)).getByText(stat.label)).toBeInTheDocument();
      }

      unmount();
    }
  });

  it("pairs each value with its own label, not a neighbor's", () => {
    const stats = [
      { value: "10", label: "Sites" },
      { value: "20", label: "Operational" },
      { value: "30", label: "Pipeline" },
      { value: "40", label: "States" },
    ];
    render(<SurveyStatRow stats={stats} />);

    for (const stat of stats) {
      expect(within(tileFor(stat.value)).getByText(stat.label)).toBeInTheDocument();
    }
  });

  it("renders the figure before its caption within each tile", () => {
    const stats = [
      { value: "42", label: "Facilities" },
      { value: "7", label: "States" },
    ];
    render(<SurveyStatRow stats={stats} />);

    for (const stat of stats) {
      expect(tileFor(stat.value).textContent).toBe(`${stat.value}${stat.label}`);
    }
  });

  it("renders a non-string ReactNode value paired with its label", () => {
    render(
      <SurveyStatRow
        stats={[{ value: <strong>99.5%</strong>, label: "Composite figure" }]}
      />
    );

    const tile = tileFor("Composite figure");
    expect(within(tile).getByText("99.5%")).toBeInTheDocument();
  });

  describe("footnotes", () => {
    it("renders no footnote line when no stat carries a note", () => {
      render(
        <SurveyStatRow
          stats={[
            { value: "10", label: "Sites" },
            { value: "50", label: "States" },
          ]}
        />
      );

      expect(within(tileFor("50")).queryByText("*")).not.toBeInTheDocument();
      expect(screen.queryByText(/^Plus /)).not.toBeInTheDocument();
    });

    it("marks the noted tile's caption and prints its note under the row", () => {
      render(
        <SurveyStatRow
          stats={[
            { value: "10", label: "Sites" },
            {
              value: "50",
              label: "States",
              note: "Plus the District of Columbia and 4 U.S. territories",
            },
          ]}
        />
      );

      expect(within(tileFor("50")).getByText("*")).toBeInTheDocument();
      expect(within(tileFor("10")).queryByText("*")).not.toBeInTheDocument();
      expect(
        screen.getByText("Plus the District of Columbia and 4 U.S. territories")
      ).toBeInTheDocument();
    });

    it("keeps the caption findable by its bare label once marked", () => {
      // Every page test locates the states tile with getByText("States");
      // appending a marker must not move that text out of reach.
      render(
        <SurveyStatRow
          stats={[{ value: "50", label: "States", note: "Plus DC" }]}
        />
      );

      expect(within(tileFor("50")).getByText("States")).toBeInTheDocument();
    });

    it("keeps the footnote out of the tile it qualifies", () => {
      // The footnote is a full-width flex ITEM, so it must not end up nested
      // inside a tile — a tile containing a sentence is exactly the crowded
      // caption this whole mechanism replaced.
      render(
        <SurveyStatRow
          stats={[{ value: "50", label: "States", note: "Plus DC" }]}
        />
      );

      expect(within(tileFor("50")).queryByText("Plus DC")).not.toBeInTheDocument();
    });

    it("gives two noted tiles distinct markers matching their own notes", () => {
      const { container } = render(
        <SurveyStatRow
          stats={[
            { value: "50", label: "States", note: "Plus DC" },
            { value: "12 GW", label: "Operational", note: "Disclosed only" },
          ]}
        />
      );

      expect(within(tileFor("50")).getByText("*")).toBeInTheDocument();
      expect(within(tileFor("12 GW")).getByText("†")).toBeInTheDocument();
      // Order on the footnote line follows tile order, so a reader scanning
      // left to right meets the markers in the order they are explained.
      expect(container.textContent).toContain("* Plus DC");
      expect(container.textContent).toContain("† Disclosed only");
    });
  });

  describe("spacing", () => {
    const stats = [
      { value: "10", label: "Sites" },
      { value: "20", label: "Operational" },
    ];

    it("defaults to the original gap-8 container classes, unchanged", () => {
      const { container } = render(<SurveyStatRow stats={stats} />);
      const row = container.firstElementChild;

      // Regression guard: this exact string is what the other 13 call sites
      // of SurveyStatRow have always rendered. If this ever fails, a change
      // meant only for /power's wide variant has leaked into every page.
      expect(row?.className).toBe(
        "flex flex-wrap gap-8 border-b border-border pb-10"
      );
    });

    it('spacing="wide" renders the wider gap-x/gap-y container classes', () => {
      const { container } = render(<SurveyStatRow stats={stats} spacing="wide" />);
      const row = container.firstElementChild;

      expect(row?.className).toBe(
        "flex flex-wrap gap-x-16 gap-y-8 border-b border-border pb-10"
      );
      // The default rhythm must not leak into the wide variant as a bare token.
      expect(row?.className).not.toMatch(/(?:^|\s)gap-8(?:\s|$)/);
    });

    it("still renders every stat's value and label with spacing=\"wide\"", () => {
      render(<SurveyStatRow stats={stats} spacing="wide" />);

      for (const stat of stats) {
        expect(within(tileFor(stat.value)).getByText(stat.label)).toBeInTheDocument();
      }
    });
  });
});
