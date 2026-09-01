import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SiteFooter } from "./site-footer";

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as components/home/open-record.test.tsx).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <a href={href} className={className} {...rest}>
      {children}
    </a>
  ),
}));

describe("SiteFooter", () => {
  it("renders the wordmark/home link with the correct aria-label", () => {
    render(<SiteFooter />);
    expect(
      screen.getByRole("link", { name: "Compute Atlas, home" })
    ).toHaveAttribute("href", "/");
  });

  it("renders the mission paragraph and independent-project attribution", () => {
    render(<SiteFooter />);
    expect(
      screen.getByText(/An open, source-cited survey of the U\.S\. compute buildout/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/An independent project by/i)).toBeInTheDocument();
  });

  it("links the maintainer's name to their personal site, opened in a new tab", () => {
    render(<SiteFooter />);
    const maintainerLink = screen.getByRole("link", { name: "Edward Kubiak" });
    expect(maintainerLink).toHaveAttribute("href", "https://edwardkubiak.com");
    expect(maintainerLink).toHaveAttribute("target", "_blank");
    expect(maintainerLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders the Explore and Data & project column labels", () => {
    render(<SiteFooter />);
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("Data & project")).toBeInTheDocument();
  });

  it("renders every Explore column link with the correct href", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("link", { name: "States" })).toHaveAttribute(
      "href",
      "/states"
    );
    expect(screen.getByRole("link", { name: "By status" })).toHaveAttribute(
      "href",
      "/status"
    );
    expect(screen.getByRole("link", { name: "By metro" })).toHaveAttribute(
      "href",
      "/metros"
    );
    expect(screen.getByRole("link", { name: "Power" })).toHaveAttribute(
      "href",
      "/power"
    );
    expect(screen.getByRole("link", { name: "Opposition" })).toHaveAttribute(
      "href",
      "/opposition"
    );
    expect(
      screen.getByRole("link", { name: /All lenses/i })
    ).toHaveAttribute("href", "/explore");
  });

  it("renders every Data & project column link with the correct href", () => {
    render(<SiteFooter />);
    expect(
      screen.getByRole("link", { name: /Data & methodology/i })
    ).toHaveAttribute("href", "/about");
    expect(screen.getByRole("link", { name: "API" })).toHaveAttribute(
      "href",
      "/api"
    );
    expect(screen.getByRole("link", { name: "Contact" })).toHaveAttribute(
      "href",
      "/contact"
    );
    expect(
      screen.getByRole("link", { name: /Contribute a facility/i })
    ).toHaveAttribute("href", "/contribute");
    expect(
      screen.getByRole("link", { name: /Recent activity/i })
    ).toHaveAttribute("href", "/activity");
    expect(
      screen.getByRole("link", { name: /Support the atlas/i })
    ).toHaveAttribute("href", "/support");
    expect(
      screen.getByRole("link", { name: /Source on GitHub/i })
    ).toHaveAttribute("href", "https://github.com/ek33450505/compute-atlas");
  });

  it("marks external links with target=_blank and rel=noreferrer noopener", () => {
    render(<SiteFooter />);
    const repo = screen.getByRole("link", { name: /Source on GitHub/i });
    const osm = screen.getByRole("link", { name: /OpenStreetMap/i });

    for (const link of [repo, osm]) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer noopener");
    }
  });

  it("renders the OpenStreetMap attribution line", () => {
    render(<SiteFooter />);
    expect(screen.getByText(/contributors/)).toBeInTheDocument();
    expect(
      // Accessible name is the aria-label ("OpenStreetMap copyright and
      // license (opens in new tab)"), which supersedes the visible link text.
      screen.getByRole("link", { name: /OpenStreetMap/i })
    ).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
  });

  it("renders the edition margin line", () => {
    render(<SiteFooter />);
    expect(screen.getByText("Compute Atlas · Edition 2026")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Coordinates: 39.5 degrees north, 98.5 degrees west")
    ).toBeInTheDocument();
  });
});
