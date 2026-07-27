import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Dialog", () => {
  it("is not present in the document when closed", () => {
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete facility</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens via the trigger and shows title + description", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete facility</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogContent>
      </Dialog>
    );

    await user.click(screen.getByRole("button", { name: "Open" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Delete facility")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("renders open via defaultOpen without needing a trigger click", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Delete facility</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("renders a default close button labeled 'Close'", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Delete facility</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("omits the close button when showCloseButton is false", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Delete facility</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    await screen.findByRole("dialog");
    expect(
      screen.queryByRole("button", { name: "Close" })
    ).not.toBeInTheDocument();
  });

  it("closes when the close button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Delete facility</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("applies data-slot attributes to content, title, and description", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Delete facility</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    await screen.findByRole("dialog");
    expect(
      document.querySelector('[data-slot="dialog-content"]')
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="dialog-title"]')
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="dialog-description"]')
    ).toBeInTheDocument();
  });

  it("merges a passed className onto DialogHeader and DialogFooter", () => {
    const { container } = render(
      <div>
        <DialogHeader className="custom-header">Header</DialogHeader>
        <DialogFooter className="custom-footer">Footer</DialogFooter>
      </div>
    );
    const header = container.querySelector('[data-slot="dialog-header"]');
    const footer = container.querySelector('[data-slot="dialog-footer"]');
    expect(header).toHaveClass("custom-header", "flex", "flex-col");
    expect(footer).toHaveClass("custom-footer", "flex");
  });

  it("renders an optional Close control in DialogFooter when showCloseButton is set", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Delete facility</DialogTitle>
          <DialogFooter showCloseButton>Actions</DialogFooter>
        </DialogContent>
      </Dialog>
    );
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("supports manual close via DialogClose rendered as a child", async () => {
    const user = userEvent.setup();
    render(
      <Dialog defaultOpen>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Delete facility</DialogTitle>
          <DialogClose>Cancel</DialogClose>
        </DialogContent>
      </Dialog>
    );
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
