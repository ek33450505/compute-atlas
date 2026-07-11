import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PowerLinksSection, hasPowerLinks } from "./power-links";
import { getFacilityById } from "@/lib/data";

// next/link renders to <a> — mock to avoid Next.js router-context dependency in jsdom
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
// hasPowerLinks predicate
// ---------------------------------------------------------------------------
describe("hasPowerLinks", () => {
  it("returns true for a power_generation facility with a campus link", () => {
    const facility = getFacilityById("oklo-aurora-pike-county-oh");
    expect(facility).toBeDefined();
    expect(hasPowerLinks(facility!)).toBe(true);
  });

  it("returns true for a compute facility powered by a generator", () => {
    const facility = getFacilityById("meta-prometheus-new-albany-oh");
    expect(facility).toBeDefined();
    expect(hasPowerLinks(facility!)).toBe(true);
  });

  it("returns false for a compute facility no plant powers", () => {
    const facility = getFacilityById("meta-prineville-or");
    expect(facility).toBeDefined();
    expect(hasPowerLinks(facility!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PowerLinksSection — power_generation branch with a named campus link
// ---------------------------------------------------------------------------
describe("PowerLinksSection — Powers (campus link)", () => {
  it("renders a Powers heading and a link to the powered campus", () => {
    const facility = getFacilityById("oklo-aurora-pike-county-oh");
    render(<PowerLinksSection facility={facility!} />);

    expect(screen.getByText("Powers")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Meta Prometheus/ });
    expect(link).toHaveAttribute(
      "href",
      "/facilities/meta-prometheus-new-albany-oh"
    );
  });
});

// ---------------------------------------------------------------------------
// PowerLinksSection — data_center branch, reverse "Powered by" link
// ---------------------------------------------------------------------------
describe("PowerLinksSection — Powered by", () => {
  it("renders a Power supply heading and a link to the powering generator", () => {
    const facility = getFacilityById("meta-prometheus-new-albany-oh");
    render(<PowerLinksSection facility={facility!} />);

    expect(screen.getByText("Power supply")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Oklo Aurora/ });
    expect(link).toHaveAttribute(
      "href",
      "/facilities/oklo-aurora-pike-county-oh"
    );
  });
});

// ---------------------------------------------------------------------------
// PowerLinksSection — power_generation branch, grid-region/company-level (no campus link)
// ---------------------------------------------------------------------------
describe("PowerLinksSection — Powers (grid-region offtaker, no campus)", () => {
  it("renders the offtaker honestly and no campus link", () => {
    const facility = getFacilityById("crane-clean-energy-center-tmi-pa");
    render(<PowerLinksSection facility={facility!} />);

    expect(screen.getByText("Powers")).toBeInTheDocument();
    expect(screen.getByText("Microsoft")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
