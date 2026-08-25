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
});
