import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { GraticuleSurvey } from "./graticule-survey";

describe("GraticuleSurvey", () => {
  it("renders as decorative (aria-hidden)", () => {
    const { container } = render(<GraticuleSurvey />);
    const root = container.querySelector("[aria-hidden='true']");
    expect(root).toBeInTheDocument();
  });

  it("renders both the vertical and horizontal grid layers", () => {
    const { container } = render(<GraticuleSurvey />);
    expect(container.querySelector(".grat-axis-x")).toBeInTheDocument();
    expect(container.querySelector(".grat-axis-y")).toBeInTheDocument();
  });

  it("forwards the className prop onto the root element", () => {
    const { container } = render(<GraticuleSurvey className="opacity-40 absolute" />);
    const root = container.querySelector(".graticule-survey");
    expect(root).toHaveClass("opacity-40", "absolute");
  });
});
