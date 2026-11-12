import { describe, it, expect, vi, afterEach } from "vitest";
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows the Free access and Commercial access links while sharing and the commercial tier are on", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    render(<SiteFooter />);
    expect(
      screen.getByRole("link", { name: "Free access for education" })
    ).toHaveAttribute("href", "/access");
    expect(
      screen.getByRole("link", { name: "Commercial access" })
    ).toHaveAttribute("href", "/access/commercial");
  });

  it("hides both access links while dataset sharing is off", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    render(<SiteFooter />);
    expect(screen.queryByRole("link", { name: "Free access for education" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Commercial access" })).toBeNull();
  });

  it("renders the wordmark/home link with an accessible name that includes its visible text", () => {
    render(<SiteFooter />);
    const home = screen.getByRole("link", {
      name: "Compute Atlas: Mapping the U.S. compute buildout, home",
    });
    expect(home).toHaveAttribute("href", "/");
    // WCAG 2.5.3 Label in Name: both visible strings (name + tagline) appear in the name.
    expect(home).toHaveAccessibleName(/^Compute Atlas/);
    expect(home).toHaveAccessibleName(/Mapping the U\.S\. compute buildout/);
  });

  it("renders the mission paragraph and independent-project attribution", () => {
    render(<SiteFooter />);
    expect(
      screen.getByText(/A source-cited survey of the U\.S\. compute buildout/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/An independent project by/i)).toBeInTheDocument();
  });

  it("names the maintainer as plain text with no link to a personal site", () => {
    const { container } = render(<SiteFooter />);
    expect(
      screen.getByText("An independent project by Edward Kubiak")
    ).toBeInTheDocument();
    expect(container.querySelector('a[href*="edwardkubiak.com"]')).toBeNull();
    expect(screen.queryByRole("link", { name: /Edward Kubiak/ })).toBeNull();
  });

  it("renders the Browse, Explore, Dataset and About column labels", () => {
    render(<SiteFooter />);
    for (const label of ["Browse", "Explore", "Dataset", "About"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("Data & project")).not.toBeInTheDocument();
  });

  it("renders every nav link with the correct href", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    const { container } = render(<SiteFooter />);
    const expected: [string, string][] = [
      ["Map", "/map"],
      ["Table", "/table"],
      ["All lenses", "/explore"],
      ["States", "/states"],
      ["By status", "/status"],
      ["By metro", "/metros"],
      ["Power", "/power"],
      ["Opposition", "/opposition"],
      ["Stats", "/stats"],
      ["Activity", "/activity"],
      ["Dataset", "/dataset"],
      ["Cite & license", "/data"],
      ["About", "/about"],
      ["Methodology", "/methodology"],
      ["Contribute", "/contribute"],
      ["Contributors", "/contributors"],
      ["Support", "/support"],
      ["Contact", "/contact"],
    ];
    for (const [name, href] of expected) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
    expect(screen.queryByRole("link", { name: "API" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Source on GitHub/i })
    ).toHaveAttribute("href", "https://github.com/ek33450505/compute-atlas");
    expect(
      screen.getByRole("link", { name: /^Bluesky/i })
    ).toHaveAttribute("href", "https://bsky.app/profile/compute-atlas.com");
    expect(
      screen.getByRole("link", { name: /^Newsletter/i })
    ).toHaveAttribute("href", "https://buttondown.com/compute-atlas");
    expect(container.innerHTML).not.toMatch(/monthly newsletter/i);
  });

  it("marks external links with target=_blank and rel=noreferrer noopener", () => {
    render(<SiteFooter />);
    const repo = screen.getByRole("link", { name: /Source on GitHub/i });
    const osm = screen.getByRole("link", { name: /OpenStreetMap/i });
    const bluesky = screen.getByRole("link", { name: /^Bluesky/i });
    const newsletter = screen.getByRole("link", { name: /^Newsletter/i });

    for (const link of [repo, osm, bluesky, newsletter]) {
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

  it("renders the margin line without a dataset version", () => {
    render(<SiteFooter />);
    expect(screen.getAllByText("Compute Atlas")).toHaveLength(2);
    expect(screen.queryByText(/v1\.30\.0/)).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Coordinates: 39.5 degrees north, 98.5 degrees west")
    ).toBeInTheDocument();
  });
});
