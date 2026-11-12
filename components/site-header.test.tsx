import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The nav children are client components with their own router/state needs;
// only the wordmark link is under test in the logo-name case below.
vi.mock("@/components/primary-nav", () => ({ PrimaryNav: () => null }));
vi.mock("@/components/mobile-nav", () => ({ MobileNav: () => null }));
vi.mock("@/components/search/command-palette", () => ({
  CommandPalette: () => null,
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { NAV_LINKS } from "@/lib/site-nav";
import { SiteHeader } from "./site-header";

// ---------------------------------------------------------------------------
// SiteHeader itself is a Server Component in the root layout; only its logo
// link is rendered here (nav children are mocked). Otherwise this asserts the desktop nav config directly: NAV_LINKS is what
// SiteHeader passes to both PrimaryNav and CommandPalette, so covering its
// shape covers both surfaces without needing to render either.
// ---------------------------------------------------------------------------

describe("SiteHeader — NAV_LINKS", () => {
  it("is exactly Map, Table, Explore, Dataset, About, in that order", () => {
    expect(NAV_LINKS).toEqual([
      { label: "Map", href: "/map" },
      { label: "Table", href: "/table" },
      { label: "Explore", href: "/explore" },
      { label: "Dataset", href: "/dataset" },
      { label: "About", href: "/about" },
    ]);
  });

  it("no longer carries Data, Stats, Activity, Contribute or Support as header items", () => {
    const labels = NAV_LINKS.map((link) => link.label);
    for (const gone of ["Data", "Stats", "Activity", "Contribute", "Support"]) {
      expect(labels).not.toContain(gone);
    }
  });
});

describe("SiteHeader — logo link", () => {
  it("has an accessible name that includes the visible wordmark and tagline (WCAG 2.5.3)", () => {
    render(<SiteHeader />);
    const home = screen.getByRole("link", {
      name: "Compute Atlas: Mapping the U.S. compute buildout, home",
    });
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveAccessibleName(/^Compute Atlas/);
    expect(home).toHaveAccessibleName(/Mapping the U\.S\. compute buildout/);
  });
});

describe("SiteHeader — GitHub icon breakpoint", () => {
  // Must switch at the same lg: (1024px) breakpoint as PrimaryNav/MobileNav,
  // or the right-hand group overflows at tablet width.
  it("reveals at lg: (1024px), not md: or xl:", () => {
    render(<SiteHeader />);
    const link = screen.getByRole("link", { name: "View source on GitHub" });

    expect(link).toHaveClass("hidden", "lg:flex");
    expect(link).not.toHaveClass("md:flex");
    expect(link).not.toHaveClass("xl:flex");
  });
});
