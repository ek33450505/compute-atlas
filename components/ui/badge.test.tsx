import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "./badge";

describe("Badge", () => {
  it("renders with data-slot=badge and default variant classes", () => {
    const { container } = render(<Badge>New</Badge>);
    const el = container.querySelector('[data-slot="badge"]');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent("New");
    expect(el).toHaveClass("bg-primary", "text-primary-foreground");
  });

  it("maps the secondary variant to its class", () => {
    const { container } = render(<Badge variant="secondary">Sec</Badge>);
    const el = container.querySelector('[data-slot="badge"]');
    expect(el).toHaveClass("bg-secondary", "text-secondary-foreground");
  });

  it("maps the destructive variant to its class", () => {
    const { container } = render(<Badge variant="destructive">Bad</Badge>);
    const el = container.querySelector('[data-slot="badge"]');
    expect(el).toHaveClass("bg-destructive/10", "text-destructive");
  });

  it("maps the outline variant to its class", () => {
    const { container } = render(<Badge variant="outline">Out</Badge>);
    const el = container.querySelector('[data-slot="badge"]');
    expect(el).toHaveClass("border-border", "text-foreground");
  });

  it("maps the ghost variant to its class", () => {
    const { container } = render(<Badge variant="ghost">Ghost</Badge>);
    const el = container.querySelector('[data-slot="badge"]');
    expect(el).toHaveClass("hover:bg-muted", "hover:text-muted-foreground");
  });

  it("maps the link variant to its class", () => {
    const { container } = render(<Badge variant="link">Link</Badge>);
    const el = container.querySelector('[data-slot="badge"]');
    expect(el).toHaveClass("text-primary", "underline-offset-4");
  });

  it("merges a passed className with variant classes", () => {
    const { container } = render(<Badge className="mt-4">Merged</Badge>);
    const el = container.querySelector('[data-slot="badge"]');
    expect(el).toHaveClass("mt-4", "bg-primary");
  });

  it("renders as an anchor when given render={<a>} and keeps badge classes", () => {
    render(
      <Badge render={<a href="/x" />} variant="secondary">
        Go
      </Badge>
    );
    const link = screen.getByRole("link", { name: "Go" });
    expect(link).toHaveAttribute("href", "/x");
    expect(link).toHaveAttribute("data-slot", "badge");
    expect(link).toHaveClass("bg-secondary", "text-secondary-foreground");
  });
});
