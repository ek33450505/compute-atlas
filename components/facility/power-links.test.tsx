import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PowerLinksSection, hasPowerLinks } from "./power-links";
import { SectionGapPrompt } from "@/components/contribute/field-gap-prompt";
import { getFacilityById } from "@/lib/data";
import { findUnpoweredDataCenter } from "@/lib/test-fixtures/unpowered-facility";

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
  it("returns true for a power_generation facility with a campus link", async () => {
    const facility = await getFacilityById("oklo-aurora-pike-county-oh");
    expect(facility).toBeDefined();
    expect(await hasPowerLinks(facility!)).toBe(true);
  });

  it("returns true for a compute facility powered by a generator", async () => {
    const facility = await getFacilityById("meta-prometheus-new-albany-oh");
    expect(facility).toBeDefined();
    expect(await hasPowerLinks(facility!)).toBe(true);
  });

  it("returns false for a compute facility no plant powers", async () => {
    const facility = await findUnpoweredDataCenter();
    expect(facility).toBeDefined();
    expect(await hasPowerLinks(facility!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PowerLinksSection — power_generation branch with a named campus link
//
// PowerLinksSection is an async Server Component (it awaits data getters
// internally). React Testing Library's client renderer cannot render an
// async component's JSX invocation directly (`<PowerLinksSection .../>`
// yields a Promise<ReactElement>, not a ReactElement) — that resolution is
// normally done by the Next.js RSC runtime, which isn't present under
// Vitest/jsdom. Call the component function directly and await its
// resolved JSX before handing it to `render()`.
// ---------------------------------------------------------------------------
describe("PowerLinksSection — Powers (campus link)", () => {
  it("renders a Powers heading and a link to the powered campus", async () => {
    const facility = await getFacilityById("oklo-aurora-pike-county-oh");
    render(await PowerLinksSection({ facility: facility! }));

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
  it("renders a Power supply heading and a link to the powering generator", async () => {
    const facility = await getFacilityById("meta-prometheus-new-albany-oh");
    render(await PowerLinksSection({ facility: facility! }));

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
  it("renders the offtaker honestly and no campus link", async () => {
    const facility = await getFacilityById("crane-clean-energy-center-tmi-pa");
    render(await PowerLinksSection({ facility: facility! }));

    expect(screen.getByText("Powers")).toBeInTheDocument();
    expect(screen.getByText("Microsoft")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// PowerLinksSection — whole-group gap (no power links data at all)
// ---------------------------------------------------------------------------
describe("PowerLinksSection — whole-group gap", () => {
  it("renders exactly one SectionGapPrompt tip trigger when no plant powers the facility, instead of a heading", async () => {
    const facility = await findUnpoweredDataCenter();
    expect(facility).toBeDefined();
    render(await PowerLinksSection({ facility: facility! }));

    const triggers = screen.getAllByRole("button");
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toHaveTextContent(/its power supply/i);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText("Power supply")).not.toBeInTheDocument();
    expect(screen.queryByText("Powers")).not.toBeInTheDocument();
  });

  it("SectionGapPrompt used for the gap does not perform an eligibility check", () => {
    render(
      <SectionGapPrompt
        facilityId="test-plant"
        facilityName="Test Plant"
        label="what this facility powers"
      />
    );
    expect(screen.getByRole("button")).toHaveTextContent(/what this facility powers/i);
  });
});
