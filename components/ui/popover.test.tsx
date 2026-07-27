import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";

describe("Popover", () => {
  it("does not render content in the document when closed", () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Popover body text</PopoverContent>
      </Popover>
    );
    expect(screen.queryByText("Popover body text")).not.toBeInTheDocument();
  });

  it("renders content in the portal when defaultOpen is set", async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Popover body text</PopoverContent>
      </Popover>
    );
    expect(await screen.findByText("Popover body text")).toBeInTheDocument();
  });

  it("opens the content after clicking the trigger", async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Popover body text</PopoverContent>
      </Popover>
    );
    expect(screen.queryByText("Popover body text")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByText("Popover body text")).toBeInTheDocument();
  });

  it("applies data-slot attributes to trigger and content", async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Popover body text</PopoverContent>
      </Popover>
    );
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute(
      "data-slot",
      "popover-trigger"
    );
    const content = await screen.findByText("Popover body text");
    expect(content).toHaveAttribute("data-slot", "popover-content");
  });

  it("merges a passed className onto the content", async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent className="w-96">Popover body text</PopoverContent>
      </Popover>
    );
    const content = await screen.findByText("Popover body text");
    expect(content).toHaveClass("w-96");
  });

  it("closes the content on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Popover body text</PopoverContent>
      </Popover>
    );
    expect(await screen.findByText("Popover body text")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Popover body text")).not.toBeInTheDocument();
  });

  it("renders header, title, and description with their data-slots", async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <PopoverHeader>
            <PopoverTitle>My Title</PopoverTitle>
            <PopoverDescription>My description</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
    );

    const title = await screen.findByText("My Title");
    expect(title).toHaveAttribute("data-slot", "popover-title");

    const description = screen.getByText("My description");
    expect(description).toHaveAttribute("data-slot", "popover-description");

    expect(title.closest('[data-slot="popover-header"]')).toBeInTheDocument();
  });

  it("merges a passed className onto the header", async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <PopoverHeader className="gap-4">Header content</PopoverHeader>
        </PopoverContent>
      </Popover>
    );
    const header = await screen.findByText("Header content");
    expect(header).toHaveClass("gap-4");
  });
});
