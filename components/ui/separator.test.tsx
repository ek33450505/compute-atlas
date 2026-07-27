import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Separator } from "./separator";

describe("Separator", () => {
  it("renders with role separator (accessible to screen readers)", () => {
    render(<Separator />);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("carries data-slot=separator", () => {
    const { container } = render(<Separator />);
    const el = container.querySelector('[data-slot="separator"]');
    expect(el).toBeInTheDocument();
  });

  it("defaults to horizontal orientation, reflected in aria-orientation and the class contract", () => {
    render(<Separator />);
    const el = screen.getByRole("separator");
    expect(el).toHaveAttribute("aria-orientation", "horizontal");
    expect(el).toHaveClass("data-horizontal:h-px", "data-horizontal:w-full");
  });

  it("reflects orientation=vertical in aria-orientation and the class contract", () => {
    render(<Separator orientation="vertical" />);
    const el = screen.getByRole("separator");
    expect(el).toHaveAttribute("aria-orientation", "vertical");
    expect(el).toHaveClass("data-vertical:w-px", "data-vertical:self-stretch");
  });

  it("merges a passed className with the base class contract", () => {
    render(<Separator className="my-4" />);
    const el = screen.getByRole("separator");
    expect(el).toHaveClass("my-4", "bg-border", "shrink-0");
  });
});
