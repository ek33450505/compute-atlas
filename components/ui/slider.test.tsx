import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Slider } from "./slider";

// jsdom never lays out elements, so Base UI's Slider thumb keeps
// `visibility: hidden` until it can measure a real bounding rect. RTL's
// role queries exclude hidden elements by default, so every role query
// below opts in via `{ hidden: true }`.
describe("Slider", () => {
  it("renders a slider role element", () => {
    render(<Slider defaultValue={[50]} />);
    expect(screen.getByRole("slider", { hidden: true })).toBeInTheDocument();
  });

  it("reflects defaultValue as aria-valuenow", () => {
    render(<Slider defaultValue={[30]} />);
    expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
      "aria-valuenow",
      "30"
    );
  });

  it("reflects a controlled value as aria-valuenow", () => {
    render(<Slider value={[65]} onValueChange={() => {}} />);
    expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
      "aria-valuenow",
      "65"
    );
  });

  it("reflects min/max on the thumb's native range input", () => {
    render(<Slider defaultValue={[10]} min={0} max={20} />);
    const slider = screen.getByRole("slider", { hidden: true });
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "20");
  });

  it("defaults min/max to 0/100 when not passed", () => {
    render(<Slider defaultValue={[50]} />);
    const slider = screen.getByRole("slider", { hidden: true });
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "100");
  });

  it("marks the thumb disabled when the slider is disabled", () => {
    render(<Slider defaultValue={[50]} disabled />);
    const slider = screen.getByRole("slider", { hidden: true });
    expect(slider).toBeDisabled();
  });

  it("merges a passed className onto the root", () => {
    const { container } = render(
      <Slider defaultValue={[50]} className="my-custom-class" />
    );
    const root = container.querySelector('[data-slot="slider"]');
    expect(root).toHaveClass("my-custom-class");
    expect(root).toHaveClass("data-horizontal:w-full");
  });

  it("assigns data-slot to track, range, and thumb", () => {
    const { container } = render(<Slider defaultValue={[50]} />);
    expect(container.querySelector('[data-slot="slider-track"]')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="slider-range"]')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="slider-thumb"]')).toBeInTheDocument();
  });

  it("renders one thumb per value for a single-value slider", () => {
    render(<Slider defaultValue={[50]} />);
    expect(screen.getAllByRole("slider", { hidden: true })).toHaveLength(1);
  });

  it("renders multiple thumbs for a multi-value (range) slider", () => {
    render(<Slider defaultValue={[20, 80]} />);
    const sliders = screen.getAllByRole("slider", { hidden: true });
    expect(sliders).toHaveLength(2);
    expect(sliders[0]).toHaveAttribute("aria-valuenow", "20");
    expect(sliders[1]).toHaveAttribute("aria-valuenow", "80");
  });

  // onValueChange requires driving pointer/keyboard interaction through Base UI's
  // internal geometry (getBoundingClientRect-dependent drag math), which jsdom does
  // not lay out. Not deterministically drivable here — dropped, see droppedAssertions.
});
