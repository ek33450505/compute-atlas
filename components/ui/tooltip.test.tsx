import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./tooltip";

// Base UI's Tooltip.Popup does not set role="tooltip" (no ARIA role of its
// own), so — per convention for presentational/non-ARIA elements — these
// tests query the data-slot attribute directly rather than getByRole.

describe("Tooltip", () => {
  it("renders the trigger with data-slot=tooltip-trigger", () => {
    render(
      <Tooltip>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Helpful info</TooltipContent>
      </Tooltip>
    );
    const trigger = screen.getByText("Hover me");
    expect(trigger).toHaveAttribute("data-slot", "tooltip-trigger");
  });

  it("renders the popup content (via defaultOpen) with data-slot=tooltip-content", () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Helpful info</TooltipContent>
      </Tooltip>
    );
    // The popup portals onto document.body, so query it there rather than
    // the render container.
    const popup = document.body.querySelector('[data-slot="tooltip-content"]');
    expect(popup).toBeInTheDocument();
    expect(popup).toHaveTextContent("Helpful info");
  });

  it("merges a passed className onto the popup", () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent className="custom-tooltip-class">
          Helpful info
        </TooltipContent>
      </Tooltip>
    );
    const popup = document.body.querySelector('[data-slot="tooltip-content"]');
    expect(popup).toHaveClass("custom-tooltip-class");
    // still carries the base contract classes
    expect(popup).toHaveClass("bg-foreground", "text-background");
  });

  it("applies the class contract for animation state variants", () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Helpful info</TooltipContent>
      </Tooltip>
    );
    const popup = document.body.querySelector('[data-slot="tooltip-content"]');
    expect(popup).toHaveClass(
      "data-open:animate-in",
      "data-closed:animate-out"
    );
  });

  it("defaults side=top on the popup (data-side reflects it when open)", () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Helpful info</TooltipContent>
      </Tooltip>
    );
    const popup = document.body.querySelector('[data-slot="tooltip-content"]');
    expect(popup).toHaveAttribute("data-side", "top");
  });

  it("passes an explicit side prop through to the popup's data-side", () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent side="bottom">Helpful info</TooltipContent>
      </Tooltip>
    );
    const popup = document.body.querySelector('[data-slot="tooltip-content"]');
    expect(popup).toHaveAttribute("data-side", "bottom");
  });

  it("TooltipProvider renders its children with wiring intact", () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent>Helpful info</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    expect(screen.getByText("Hover me")).toBeInTheDocument();
  });
});
