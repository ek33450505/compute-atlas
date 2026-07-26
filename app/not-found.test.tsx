import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import NotFound from "./not-found";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NotFound (app/not-found.tsx)", () => {
  it("renders an h1 with the 404 heading", () => {
    render(<NotFound />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Off the edge of the map" })
    ).toBeInTheDocument();
  });

  it("renders a link back to the home page", () => {
    render(<NotFound />);
    expect(screen.getByRole("link", { name: "Back to the map" })).toHaveAttribute(
      "href",
      "/"
    );
  });

  it("renders a link to /explore", () => {
    render(<NotFound />);
    expect(
      screen.getByRole("link", { name: "Explore the data" })
    ).toHaveAttribute("href", "/explore");
  });
});
