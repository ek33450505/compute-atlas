import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Breadcrumb } from "./breadcrumb";

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
// Fixtures
// ---------------------------------------------------------------------------

const TRAIL = [
  { label: "Explore", href: "/explore" },
  { label: "States", href: "/states" },
  { label: "New York" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Breadcrumb", () => {
  it("renders a nav with accessible name 'Breadcrumb'", () => {
    render(<Breadcrumb items={TRAIL} />);
    expect(
      screen.getByRole("navigation", { name: /breadcrumb/i })
    ).toBeInTheDocument();
  });

  it("renders intermediate crumbs with an href as links", () => {
    render(<Breadcrumb items={TRAIL} />);
    const link = screen.getByRole("link", { name: "Explore" });
    expect(link).toHaveAttribute("href", "/explore");

    const statesLink = screen.getByRole("link", { name: "States" });
    expect(statesLink).toHaveAttribute("href", "/states");
  });

  it("renders the last crumb as non-link text with aria-current=page", () => {
    render(<Breadcrumb items={TRAIL} />);
    expect(screen.getByText("New York")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "New York" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("New York")).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("renders a middle crumb without an href as a span, not a link", () => {
    const items = [
      { label: "Explore", href: "/explore" },
      { label: "Pending" },
      { label: "New York" },
    ];
    render(<Breadcrumb items={items} />);
    expect(
      screen.queryByRole("link", { name: "Pending" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });
});
