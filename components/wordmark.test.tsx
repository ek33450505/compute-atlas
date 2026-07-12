import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Wordmark } from "./wordmark";

describe("Wordmark", () => {
  it("renders the site name", () => {
    render(<Wordmark />);
    expect(screen.getByText("Compute Atlas")).toBeInTheDocument();
  });

  it("hides the decorative datum mark from assistive tech", () => {
    const { container } = render(<Wordmark />);
    const svg = container.querySelector("svg.wordmark-mark");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  it("normalizes the drawn strokes with pathLength so the draw-in animation is geometry-independent", () => {
    const { container } = render(<Wordmark />);
    const rect = container.querySelector(".wordmark-frame");
    const lineV = container.querySelector(".wordmark-axis-v");
    const lineH = container.querySelector(".wordmark-axis-h");
    expect(rect).toHaveAttribute("pathLength", "1");
    expect(lineV).toHaveAttribute("pathLength", "1");
    expect(lineH).toHaveAttribute("pathLength", "1");
  });

  it("does not add pathLength to the filled datum dot (it animates via transform, not dash-offset)", () => {
    const { container } = render(<Wordmark />);
    const dot = container.querySelector(".wordmark-datum");
    expect(dot).not.toHaveAttribute("pathLength");
  });

  it("renders the optional tagline only when showTagline is true", () => {
    const { rerender } = render(<Wordmark />);
    expect(
      screen.queryByText("Mapping the U.S. compute buildout")
    ).not.toBeInTheDocument();

    rerender(<Wordmark showTagline />);
    expect(
      screen.getByText("Mapping the U.S. compute buildout")
    ).toBeInTheDocument();
  });
});
