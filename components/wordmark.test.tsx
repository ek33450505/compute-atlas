import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Wordmark } from "./wordmark";

describe("Wordmark", () => {
  it("renders the site name", () => {
    render(<Wordmark />);
    expect(screen.getByText("Compute Atlas")).toBeInTheDocument();
  });

  it("hides the decorative plate-stack mark from assistive tech", () => {
    const { container } = render(<Wordmark />);
    const svg = container.querySelector("svg.wordmark-mark");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  it("renders the back plate, front plate, and datum square", () => {
    const { container } = render(<Wordmark />);
    const backPlate = container.querySelector(".wordmark-plate-back");
    const frontPlate = container.querySelector(".wordmark-plate-front");
    const datum = container.querySelector(".wordmark-datum");
    expect(backPlate).toBeInTheDocument();
    expect(frontPlate).toBeInTheDocument();
    expect(datum).toBeInTheDocument();
  });

  it("does not use pathLength on the plate-slide mark (it animates via transform/opacity, not dash-offset)", () => {
    const { container } = render(<Wordmark />);
    const backPlate = container.querySelector(".wordmark-plate-back");
    const frontPlate = container.querySelector(".wordmark-plate-front");
    const datum = container.querySelector(".wordmark-datum");
    expect(backPlate).not.toHaveAttribute("pathLength");
    expect(frontPlate).not.toHaveAttribute("pathLength");
    expect(datum).not.toHaveAttribute("pathLength");
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
