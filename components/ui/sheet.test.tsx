import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "./sheet";

describe("Sheet", () => {
  it("opens via trigger click and exposes a dialog with its title", async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent>
          <SheetTitle>Panel title</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Panel title" })
    ).toBeInTheDocument();
  });

  it("renders open via defaultOpen with dialog role and title", () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>Defaulted open</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Defaulted open" })
    ).toBeInTheDocument();
  });

  it("defaults the side to right and applies its data-side + class contract", () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>Right side</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    const content = screen.getByRole("dialog");
    expect(content).toHaveAttribute("data-side", "right");
    expect(content).toHaveClass(
      "data-[side=right]:inset-y-0",
      "data-[side=right]:right-0"
    );
  });

  it("applies the side prop to data-side and its class contract", () => {
    render(
      <Sheet defaultOpen>
        <SheetContent side="left">
          <SheetTitle>Left side</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    const content = screen.getByRole("dialog");
    expect(content).toHaveAttribute("data-side", "left");
    expect(content).toHaveClass(
      "data-[side=left]:inset-y-0",
      "data-[side=left]:left-0"
    );
  });

  it("renders a close button with an accessible name by default", () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>Closable</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(
      screen.getByRole("button", { name: "Close" })
    ).toBeInTheDocument();
  });

  it("omits the close button when showCloseButton is false", () => {
    render(
      <Sheet defaultOpen>
        <SheetContent showCloseButton={false}>
          <SheetTitle>No close button</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(
      screen.queryByRole("button", { name: "Close" })
    ).not.toBeInTheDocument();
  });

  it("closes when the close button is clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Sheet defaultOpen onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetTitle>Dismissible</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it("supports a custom SheetClose element for dismissing", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Sheet defaultOpen onOpenChange={onOpenChange}>
        <SheetContent showCloseButton={false}>
          <SheetTitle>Custom close</SheetTitle>
          <SheetClose>Dismiss</SheetClose>
        </SheetContent>
      </Sheet>
    );

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onOpenChange).toHaveBeenCalled();
  });

  it("renders the description and wires data-slot attributes for header/footer/description", () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Header title</SheetTitle>
            <SheetDescription>Some description</SheetDescription>
          </SheetHeader>
          <SheetFooter>Footer content</SheetFooter>
        </SheetContent>
      </Sheet>
    );

    expect(screen.getByText("Some description")).toBeInTheDocument();
    expect(screen.getByText("Header title").closest('[data-slot="sheet-title"]')).not.toBeNull();
  });

  it("merges a passed className on SheetContent", () => {
    render(
      <Sheet defaultOpen>
        <SheetContent className="custom-content-class">
          <SheetTitle>Classed</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    expect(screen.getByRole("dialog")).toHaveClass("custom-content-class");
  });

  it("data-slot presence on header and footer", () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>Slots</SheetTitle>
          <SheetHeader className="header-class">Header</SheetHeader>
          <SheetFooter className="footer-class">Footer</SheetFooter>
        </SheetContent>
      </Sheet>
    );

    // SheetContent renders into a portal on document.body, so query there
    // rather than the render() container.
    const header = document.body.querySelector('[data-slot="sheet-header"]');
    const footer = document.body.querySelector('[data-slot="sheet-footer"]');
    expect(header).toHaveClass("header-class");
    expect(footer).toHaveClass("footer-class");
  });
});
