import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompassRose } from "./compass-rose";

describe("CompassRose", () => {
  it("renders a button with the correct aria-label", () => {
    render(<CompassRose bearing={0} onResetNorth={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Reset map orientation to north" })
    ).toBeInTheDocument();
  });

  it("calls onResetNorth when clicked", async () => {
    const user = userEvent.setup();
    const onResetNorth = vi.fn();
    render(<CompassRose bearing={0} onResetNorth={onResetNorth} />);
    await user.click(
      screen.getByRole("button", { name: "Reset map orientation to north" })
    );
    expect(onResetNorth).toHaveBeenCalledTimes(1);
  });

  it("reflects bearing in the SVG group rotation style", () => {
    const { container } = render(
      <CompassRose bearing={45} onResetNorth={() => {}} />
    );
    // The SVG <g> element carries the rotation transform (-bearing)
    const group = container.querySelector("svg g");
    expect(group).toBeDefined();
    const style = (group as HTMLElement).getAttribute("style") ?? "";
    expect(style).toContain("rotate(-45deg)");
  });

  it("applies activation classes when bearing is non-zero (> epsilon)", () => {
    const { rerender } = render(
      <CompassRose bearing={0} onResetNorth={() => {}} />
    );
    const btn0 = screen.getByRole("button", {
      name: "Reset map orientation to north",
    });
    // At bearing 0: no activation ring class
    expect(btn0.className).not.toContain("ring-primary");

    rerender(<CompassRose bearing={10} onResetNorth={() => {}} />);
    const btn10 = screen.getByRole("button", {
      name: "Reset map orientation to north",
    });
    // At bearing 10 (> NORTH_EPSILON 0.5): activation ring applied
    expect(btn10.className).toContain("ring-primary");
  });

  it("SVG is aria-hidden (decorative)", () => {
    const { container } = render(
      <CompassRose bearing={0} onResetNorth={() => {}} />
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});
