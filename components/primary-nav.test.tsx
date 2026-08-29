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
  { label: "Stats", href: "/stats" },
  { label: "Explore", href: "/explore" },
  { label: "Activity", href: "/activity" },
  { label: "Contribute", href: "/contribute" },
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

  it("renders all 7 links with correct hrefs", () => {
    render(<PrimaryNav links={NAV_LINKS} />);

    expect(NAV_LINKS).toHaveLength(7);
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
  // Regression cover for the site-wide horizontal-overflow bug: all 7 links'
  // bare text alone (no padding) measures ~310px, which cannot fit inline
  // below ~750px viewport width no matter how much padding/gap is trimmed —
  // so the nav must stay hidden through the sm: tier (640px) and reveal only
  // at md: (768px), where the header's other fixed-width elements (wordmark,
  // search, GitHub icon) leave enough room. Reverting "md" to "sm" here
  // reproduces the original bug (measured 803px content in a 640px viewport).
  it("reveals at the md: (768px) breakpoint, not sm: (640px)", () => {
    render(<PrimaryNav links={NAV_LINKS} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });

    expect(nav).toHaveClass("hidden", "md:flex");
    expect(nav).not.toHaveClass("sm:flex");
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
    expect(screen.getByRole("link", { name: "Stats" })).not.toHaveAttribute(
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
