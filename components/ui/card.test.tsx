import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from "./card";

describe("Card", () => {
  it("renders with data-slot='card' and defaults data-size to 'default'", () => {
    const { container } = render(<Card />);
    const el = container.querySelector('[data-slot="card"]');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("data-size", "default");
  });

  it("reflects the size prop on data-size", () => {
    const { container } = render(<Card size="sm" />);
    const el = container.querySelector('[data-slot="card"]');
    expect(el).toHaveAttribute("data-size", "sm");
  });

  it("merges a passed className alongside its own classes", () => {
    const { container } = render(<Card className="my-custom-class" />);
    const el = container.querySelector('[data-slot="card"]');
    expect(el).toHaveClass("my-custom-class", "flex", "flex-col");
  });
});

describe("Card subcomponents", () => {
  it("CardHeader renders with data-slot='card-header'", () => {
    const { container } = render(<CardHeader className="hdr" />);
    const el = container.querySelector('[data-slot="card-header"]');
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass("hdr");
  });

  it("CardTitle renders with data-slot='card-title' and its text", () => {
    render(<CardTitle>Facility Name</CardTitle>);
    const el = screen.getByText("Facility Name");
    expect(el).toHaveAttribute("data-slot", "card-title");
  });

  it("CardDescription renders with data-slot='card-description' and its text", () => {
    render(<CardDescription>A short description</CardDescription>);
    const el = screen.getByText("A short description");
    expect(el).toHaveAttribute("data-slot", "card-description");
  });

  it("CardAction renders with data-slot='card-action'", () => {
    const { container } = render(<CardAction>Action</CardAction>);
    const el = container.querySelector('[data-slot="card-action"]');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent("Action");
  });

  it("CardContent renders with data-slot='card-content' and its children", () => {
    render(
      <CardContent>
        <p>Body copy</p>
      </CardContent>
    );
    const el = screen.getByText("Body copy").closest('[data-slot="card-content"]');
    expect(el).toBeInTheDocument();
  });

  it("CardFooter renders with data-slot='card-footer'", () => {
    const { container } = render(<CardFooter>Footer</CardFooter>);
    const el = container.querySelector('[data-slot="card-footer"]');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent("Footer");
  });
});

describe("Composed Card", () => {
  it("renders a full composition with all parts and their content", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Union Ridge Data Center</CardTitle>
          <CardDescription>Loudoun County, VA</CardDescription>
          <CardAction>Edit</CardAction>
        </CardHeader>
        <CardContent>
          <p>200 MW planned capacity</p>
        </CardContent>
        <CardFooter>Last updated 2026-07-26</CardFooter>
      </Card>
    );

    expect(screen.getByText("Union Ridge Data Center")).toBeInTheDocument();
    expect(screen.getByText("Loudoun County, VA")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("200 MW planned capacity")).toBeInTheDocument();
    expect(screen.getByText("Last updated 2026-07-26")).toBeInTheDocument();
  });
});
