import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PercentageBar } from "./percentage-bar";

describe("PercentageBar", () => {
  it("renders the label and valueLabel text", () => {
    render(<PercentageBar label="Data center" valueLabel="12 · 40%" pct={40} />);
    expect(screen.getByText("Data center")).toBeInTheDocument();
    expect(screen.getByText("12 · 40%")).toBeInTheDocument();
  });

  it("defaults to a div root with the primary swatch at 0.7 opacity and no transition", () => {
    const { container } = render(
      <PercentageBar label="Operational" valueLabel="5 · 50%" pct={50} />
    );
    expect(container.firstElementChild?.tagName).toBe("DIV");

    const fill = container.querySelector('[aria-hidden="true"]');
    expect(fill).not.toBeNull();
    expect(fill).toHaveClass("h-full", "rounded-full");
    expect(fill?.className).not.toContain("transition-all");
    expect(fill).toHaveStyle({
      width: "50.00%",
      backgroundColor: "var(--primary)",
      opacity: "0.7",
    });
  });

  it("renders 0% width as a two-decimal string, not 0", () => {
    const { container } = render(
      <PercentageBar label="Cancelled" valueLabel="0 · 0%" pct={0} />
    );
    const fill = container.querySelector('[aria-hidden="true"]');
    expect(fill).toHaveStyle({ width: "0.00%" });
  });

  it("supports the status-tinted variant: custom color, full opacity, transition-all", () => {
    const { container } = render(
      <PercentageBar
        label="Under construction"
        valueLabel="3 · 30%"
        pct={30}
        color="#ff8800"
        opacity={1}
        transition
      />
    );
    const fill = container.querySelector('[aria-hidden="true"]');
    expect(fill).toHaveClass("h-full", "rounded-full", "transition-all");
    expect(fill).toHaveStyle({
      width: "30.00%",
      backgroundColor: "#ff8800",
      opacity: "1",
    });
  });

  it("renders an li root when as='li' is passed, for callers composing a <ul>", () => {
    const { container } = render(
      <ul>
        <PercentageBar as="li" label="Grid" valueLabel="8 · 80%" pct={80} />
      </ul>
    );
    const item = container.querySelector("ul")?.firstElementChild;
    expect(item?.tagName).toBe("LI");
    expect(item).toHaveClass("space-y-1.5");
  });

  it("accepts a non-string ReactNode valueLabel (e.g. a composed fragment)", () => {
    render(
      <PercentageBar
        label="Litigation"
        valueLabel={
          <>
            <span>4</span> of <span>10</span>
          </>
        }
        pct={40}
      />
    );
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("of")).toBeInTheDocument();
  });
});
