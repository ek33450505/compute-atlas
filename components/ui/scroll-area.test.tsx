import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { ScrollArea, ScrollBar } from "./scroll-area";

describe("ScrollArea", () => {
  it("renders the viewport content", () => {
    render(
      <ScrollArea>
        <div>Facility list item</div>
      </ScrollArea>
    );
    expect(screen.getByText("Facility list item")).toBeInTheDocument();
  });

  it("sets data-slot on the root and viewport", () => {
    const { container } = render(
      <ScrollArea>
        <div>content</div>
      </ScrollArea>
    );
    expect(
      container.querySelector('[data-slot="scroll-area"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="scroll-area-viewport"]')
    ).toBeInTheDocument();
  });

  it("merges a passed className onto the root", () => {
    const { container } = render(
      <ScrollArea className="max-h-52 rounded-lg">
        <div>content</div>
      </ScrollArea>
    );
    const root = container.querySelector('[data-slot="scroll-area"]');
    expect(root).toHaveClass("relative", "max-h-52", "rounded-lg");
  });

  it("nests the viewport under the root", () => {
    const { container } = render(
      <ScrollArea>
        <div>content</div>
      </ScrollArea>
    );
    const root = container.querySelector('[data-slot="scroll-area"]');
    expect(
      root?.querySelector('[data-slot="scroll-area-viewport"]')
    ).toBeInTheDocument();
  });
});

// ScrollBar/Thumb are conditionally rendered by Base UI based on measured
// overflow, which jsdom never reports — so these tests force rendering via
// `keepMounted` and provide the Root context ScrollBar requires, rather than
// relying on the real overflow-driven visibility (not jsdom-testable).
describe("ScrollBar", () => {
  it("defaults to vertical orientation", () => {
    const { container } = render(
      <ScrollAreaPrimitive.Root>
        <ScrollBar keepMounted />
      </ScrollAreaPrimitive.Root>
    );
    const bar = container.querySelector('[data-slot="scroll-area-scrollbar"]');
    expect(bar).toHaveAttribute("data-orientation", "vertical");
  });

  it("passes through a horizontal orientation", () => {
    const { container } = render(
      <ScrollAreaPrimitive.Root>
        <ScrollBar orientation="horizontal" keepMounted />
      </ScrollAreaPrimitive.Root>
    );
    const bar = container.querySelector('[data-slot="scroll-area-scrollbar"]');
    expect(bar).toHaveAttribute("data-orientation", "horizontal");
  });

  it("merges a passed className onto the scrollbar", () => {
    const { container } = render(
      <ScrollAreaPrimitive.Root>
        <ScrollBar className="bg-red-500" keepMounted />
      </ScrollAreaPrimitive.Root>
    );
    const bar = container.querySelector('[data-slot="scroll-area-scrollbar"]');
    expect(bar).toHaveClass("flex", "bg-red-500");
  });

  it("renders a thumb with the bg-border class", () => {
    const { container } = render(
      <ScrollAreaPrimitive.Root>
        <ScrollBar keepMounted />
      </ScrollAreaPrimitive.Root>
    );
    const thumb = container.querySelector('[data-slot="scroll-area-thumb"]');
    expect(thumb).toBeInTheDocument();
    expect(thumb).toHaveClass("bg-border");
  });
});
