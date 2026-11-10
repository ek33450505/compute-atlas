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

import { NAV_LINKS, MOBILE_NAV_GROUPS, SiteHeader } from "./site-header";

// ---------------------------------------------------------------------------
// SiteHeader itself is a Server Component in the root layout; only its logo
// link is rendered here (nav children are mocked). Otherwise this asserts the desktop nav config directly: NAV_LINKS is what
// SiteHeader passes to both PrimaryNav and CommandPalette, so covering its
// shape covers both surfaces without needing to render either.
// ---------------------------------------------------------------------------

describe("SiteHeader — Data label", () => {
  it("labels /data as Data in both nav surfaces, with no Cite entry", () => {
    expect(NAV_LINKS).toContainEqual({ label: "Data", href: "/data" });
    const mobile = MOBILE_NAV_GROUPS.flatMap((g) => [...g.links] as { label: string; href: string }[]);
    expect(mobile).toContainEqual({ label: "Data", href: "/data" });
    expect([...NAV_LINKS, ...mobile].some((l) => l.label === "Cite")).toBe(false);
  });
});

describe("SiteHeader — NAV_LINKS", () => {
  it("includes a Contribute entry pointing at /contribute", () => {
    const contribute = NAV_LINKS.find((link) => link.label === "Contribute");
    expect(contribute).toBeDefined();
    expect(contribute?.href).toBe("/contribute");
  });

  it("places Contribute after Activity and before About", () => {
    const labels = NAV_LINKS.map((link) => link.label);
    const activityIndex = labels.indexOf("Activity");
    const contributeIndex = labels.indexOf("Contribute");
    const aboutIndex = labels.indexOf("About");

    expect(activityIndex).toBeGreaterThanOrEqual(0);
    expect(contributeIndex).toBe(activityIndex + 1);
    expect(aboutIndex).toBe(contributeIndex + 1);
  });
});

// ---------------------------------------------------------------------------
// Task C4 — 1,064 facility pages previously carried zero funding ask, and
// there was no "Support" entry in either nav surface. Both must carry one so
// the /support ask is reachable without knowing the URL.
// ---------------------------------------------------------------------------

describe("SiteHeader — Support is reachable in both desktop and mobile nav", () => {
  it("NAV_LINKS (desktop) includes a Support entry pointing at /support", () => {
    const support = NAV_LINKS.find((link) => link.label === "Support");
    expect(support).toBeDefined();
    expect(support?.href).toBe("/support");
  });

  it("MOBILE_NAV_GROUPS includes a Support entry pointing at /support", () => {
    // Explicit accumulation, not .flatMap: MOBILE_NAV_GROUPS is a tuple of
    // differently-shaped `as const` group literals, and TS can't unify
    // .flatMap's return type across them — see the typecheck failure this
    // replaced.
    const allLinks: { label: string; href: string; external?: boolean }[] = [];
    for (const group of MOBILE_NAV_GROUPS) {
      allLinks.push(...group.links);
    }
    const support = allLinks.find((link) => link.label === "Support");
    expect(support).toBeDefined();
    expect(support?.href).toBe("/support");
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
