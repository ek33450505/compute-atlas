import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";

describe("Tabs", () => {
  it("renders a tablist with tab items", () => {
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Content one</TabsContent>
        <TabsContent value="two">Content two</TabsContent>
      </Tabs>
    );

    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "One" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Two" })).toBeInTheDocument();
  });

  it("applies data-slot attributes to each part", () => {
    const { container } = render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Content one</TabsContent>
      </Tabs>
    );

    expect(
      container.querySelector('[data-slot="tabs"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="tabs-list"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="tabs-trigger"]')
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="tabs-content"]')
    ).toBeInTheDocument();
  });

  it("sets the initial selection via defaultValue", () => {
    render(
      <Tabs defaultValue="two">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Content one</TabsContent>
        <TabsContent value="two">Content two</TabsContent>
      </Tabs>
    );

    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Content two");
  });

  it("switches selected tab and panel on click", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Content one</TabsContent>
        <TabsContent value="two">Content two</TabsContent>
      </Tabs>
    );

    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    await user.click(screen.getByRole("tab", { name: "Two" }));

    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Content two");
  });

  it("maps the line variant to transparent-background classes on TabsList", () => {
    const { container } = render(
      <Tabs defaultValue="one">
        <TabsList variant="line">
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Content one</TabsContent>
      </Tabs>
    );

    const list = container.querySelector('[data-slot="tabs-list"]');
    expect(list).toHaveAttribute("data-variant", "line");
    expect(list).toHaveClass("bg-transparent");
  });

  it("defaults TabsList variant to default and merges a passed className", () => {
    const { container } = render(
      <Tabs defaultValue="one">
        <TabsList className="my-extra-class">
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Content one</TabsContent>
      </Tabs>
    );

    const list = container.querySelector('[data-slot="tabs-list"]');
    expect(list).toHaveAttribute("data-variant", "default");
    expect(list).toHaveClass("bg-muted", "my-extra-class");
  });

  it("defaults Tabs orientation to horizontal and reflects data-orientation", () => {
    const { container } = render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Content one</TabsContent>
      </Tabs>
    );

    expect(container.querySelector('[data-slot="tabs"]')).toHaveAttribute(
      "data-orientation",
      "horizontal"
    );
  });

  it("passes through orientation=vertical to data-orientation", () => {
    const { container } = render(
      <Tabs defaultValue="one" orientation="vertical">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Content one</TabsContent>
      </Tabs>
    );

    expect(container.querySelector('[data-slot="tabs"]')).toHaveAttribute(
      "data-orientation",
      "vertical"
    );
  });

  // Base UI gives an open panel tabIndex 0, so it is a Tab stop; it keeps
  // outline-none and had no focus cue at all. `outline-solid` is load-bearing:
  // outline-none sets --tw-outline-style: none, which outline-2 would otherwise
  // read. See button.tsx.
  it("draws a real focus-visible outline on the open panel alongside outline-none", () => {
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Content one</TabsContent>
      </Tabs>
    );
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("tabindex", "0");
    expect(panel).toHaveClass(
      "outline-none",
      "focus-visible:outline-2",
      "focus-visible:outline-solid",
      "focus-visible:outline-ring"
    );
  });
});
