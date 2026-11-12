import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { PrimaryNav } from "./primary-nav";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: vi.fn().mockReturnValue("/"),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    "aria-current": ariaCurrent,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    "aria-current"?: React.AriaAttributes["aria-current"];
  }) => (
    <a href={href} className={className} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  { label: "Map", href: "/map" },
  { label: "Table", href: "/table" },
  { label: "Explore", href: "/explore" },
  { label: "Dataset", href: "/dataset" },
  { label: "About", href: "/about" },
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PrimaryNav — render", () => {
  it("renders all links", () => {
    render(<PrimaryNav links={NAV_LINKS} />);

    for (const { label } of NAV_LINKS) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("renders all 5 links with correct hrefs", () => {
    render(<PrimaryNav links={NAV_LINKS} />);

    expect(NAV_LINKS).toHaveLength(5);
    for (const { label, href } of NAV_LINKS) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute(
        "href",
        href
      );
    }
  });

  it("has an accessible Primary nav landmark", () => {
    render(<PrimaryNav links={NAV_LINKS} />);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });
});

describe("PrimaryNav — responsive breakpoint", () => {
  // Regression cover for the header-overflow bug: the inline links must not
  // overflow beside the wordmark, search and GitHub icon, so the nav reveals
  // only at lg: (1024px; measured 2026-11-12). The toggle and the GitHub icon
  // switch at the same breakpoint.
  it("reveals at the lg: (1024px) breakpoint, not md: or xl:", () => {
    render(<PrimaryNav links={NAV_LINKS} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });

    expect(nav).toHaveClass("hidden", "lg:flex");
    expect(nav).not.toHaveClass("md:flex");
    expect(nav).not.toHaveClass("xl:flex");
  });
});

describe("PrimaryNav — active-page indicator", () => {
  it("sets aria-current=page only on the link matching the current pathname", () => {
    vi.mocked(usePathname).mockReturnValue("/table");

    render(<PrimaryNav links={NAV_LINKS} />);

    expect(screen.getByRole("link", { name: "Table" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Map" })).not.toHaveAttribute(
      "aria-current"
    );
    expect(screen.getByRole("link", { name: "Explore" })).not.toHaveAttribute(
      "aria-current"
    );
    expect(screen.getByRole("link", { name: "About" })).not.toHaveAttribute(
      "aria-current"
    );

    vi.mocked(usePathname).mockReturnValue("/");
  });

  it("sets no aria-current on any link when the pathname matches none of them", () => {
    vi.mocked(usePathname).mockReturnValue("/facilities/some-facility");

    render(<PrimaryNav links={NAV_LINKS} />);

    for (const { label } of NAV_LINKS) {
      expect(screen.getByRole("link", { name: label })).not.toHaveAttribute(
        "aria-current"
      );
    }

    vi.mocked(usePathname).mockReturnValue("/");
  });
});
