import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Label } from "./label";

describe("Label", () => {
  it("renders its text content", () => {
    render(<Label>Facility name</Label>);
    expect(screen.getByText("Facility name")).toBeInTheDocument();
  });

  it("sets data-slot=label", () => {
    const { container } = render(<Label>Facility name</Label>);
    const el = container.querySelector('[data-slot="label"]');
    expect(el).toBeInTheDocument();
  });

  it("associates with a control via htmlFor so getByLabelText finds it", () => {
    render(
      <>
        <Label htmlFor="facility-name">Facility name</Label>
        <input id="facility-name" />
      </>
    );
    expect(screen.getByLabelText("Facility name")).toBeInstanceOf(
      HTMLInputElement
    );
  });

  it("merges a passed className with the base class contract", () => {
    const { container } = render(
      <Label className="text-red-500">Facility name</Label>
    );
    const el = container.querySelector('[data-slot="label"]');
    expect(el).toHaveClass("text-red-500");
    expect(el).toHaveClass("flex", "items-center", "gap-2", "text-sm");
  });
});
