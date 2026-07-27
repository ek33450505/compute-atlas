import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuGroup,
} from "./dropdown-menu";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//
// Base UI's Menu.Popup mounts its portal content asynchronously (a frame
// after open state flips), so every "menu is open" assertion below awaits a
// findBy* query rather than a synchronous getBy*.

function BasicMenu({
  onSelect,
  defaultOpen,
}: {
  onSelect?: () => void;
  defaultOpen?: boolean;
}) {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuItem onClick={onSelect}>Edit</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DropdownMenu", () => {
  it("is closed by default: no menu role until opened", () => {
    render(<BasicMenu />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open menu" })
    ).toBeInTheDocument();
  });

  it("opens via trigger click, exposing a menu with menuitem items", async () => {
    const user = userEvent.setup();
    render(<BasicMenu />);

    await user.click(screen.getByRole("button", { name: "Open menu" }));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete" })
    ).toBeInTheDocument();
  });

  it("opens deterministically via defaultOpen", async () => {
    render(<BasicMenu defaultOpen />);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("fires an item's onClick when selected and closes the menu", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<BasicMenu defaultOpen onSelect={onSelect} />);

    const item = await screen.findByRole("menuitem", { name: "Edit" });
    await user.click(item);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renders a label and separator inside the menu", async () => {
    render(<BasicMenu defaultOpen />);
    await screen.findByRole("menu");

    expect(screen.getByText("Actions")).toHaveAttribute(
      "data-slot",
      "dropdown-menu-label"
    );
    const separator = document.querySelector(
      '[data-slot="dropdown-menu-separator"]'
    );
    expect(separator).toBeInTheDocument();
    expect(separator).toHaveAttribute("role", "separator");
  });

  it("applies the destructive variant data attribute to the corresponding item", async () => {
    render(<BasicMenu defaultOpen />);
    const destructiveItem = await screen.findByRole("menuitem", {
      name: "Delete",
    });
    expect(destructiveItem).toHaveAttribute("data-variant", "destructive");
    expect(destructiveItem).toHaveClass(
      "data-[variant=destructive]:text-destructive"
    );
  });

  it("sets data-slot on the content popup and trigger", async () => {
    render(<BasicMenu defaultOpen />);
    await screen.findByRole("menu");

    const content = document.querySelector(
      '[data-slot="dropdown-menu-content"]'
    );
    expect(content).toBeInTheDocument();

    const trigger = document.querySelector(
      '[data-slot="dropdown-menu-trigger"]'
    );
    expect(trigger).toBeInTheDocument();
  });

  it("merges a passed className onto the content popup", async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent className="w-64">
          <DropdownMenuItem>Only item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    await screen.findByRole("menu");

    const content = document.querySelector(
      '[data-slot="dropdown-menu-content"]'
    );
    expect(content).toHaveClass("w-64");
  });

  it("marks an inset item/label with data-inset", async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel inset>Section</DropdownMenuLabel>
            <DropdownMenuItem inset>Inset item</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    await screen.findByRole("menu");

    expect(screen.getByText("Section")).toHaveAttribute("data-inset", "true");
    expect(
      screen.getByRole("menuitem", { name: "Inset item" })
    ).toHaveAttribute("data-inset", "true");
  });
});
