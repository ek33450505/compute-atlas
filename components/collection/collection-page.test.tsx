import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { Facility } from "@/lib/schema";
import { CollectionPage } from "./collection-page";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
// Fixtures
// ---------------------------------------------------------------------------

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "site-one",
    name: "Site One",
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 40, lon: -90, city: "Springfield", state: "IL", precision: "exact" },
    capacityMw: { operational: 150 },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Example source", retrievedAt: "2025-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

const CRUMBS = [
  { label: "Explore", href: "/explore" },
  { label: "By status", href: "/status" },
  { label: "Operational" },
];

const STAT_ROW = [
  { label: "Sites", value: "2" },
  { label: "Operational capacity", value: "300 MW" },
];

const FACILITIES = [
  makeFacility(),
  makeFacility({
    id: "site-two",
    name: "Site Two",
    operator: "Beta LLC",
    location: { lat: 41, lon: -91, city: "Peoria", state: "IL", precision: "exact" },
    capacityMw: { planned: 400 },
  }),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CollectionPage", () => {
  it("renders the title as an h1, the intro, breadcrumb trail, and stat row", () => {
    render(
      <CollectionPage
        title="Operational data centers in the US"
        intro={<p>Facilities that are built and running today.</p>}
        crumbs={CRUMBS}
        statRow={STAT_ROW}
        facilities={FACILITIES}
      />
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Operational data centers in the US" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("Facilities that are built and running today.")
    ).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Explore" })).toHaveAttribute("href", "/explore");
    // "Operational" also appears as a card's StatusBadge label — scope to the
    // breadcrumb nav so this asserts the last-crumb markup specifically.
    expect(within(nav).getByText("Operational")).toHaveAttribute("aria-current", "page");

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Sites")).toBeInTheDocument();
    expect(screen.getByText("300 MW")).toBeInTheDocument();
    expect(screen.getByText("Operational capacity")).toBeInTheDocument();
  });

  it("renders one card per facility, each a link to its facility page with name/operator/location/capacity", () => {
    render(
      <CollectionPage
        title="Operational data centers in the US"
        intro="intro"
        crumbs={CRUMBS}
        statRow={STAT_ROW}
        facilities={FACILITIES}
      />
    );

    const cardOne = screen.getByRole("link", { name: /Site One/ });
    expect(cardOne).toHaveAttribute("href", "/facilities/site-one");
    expect(cardOne).toHaveTextContent("Acme Corp");
    expect(cardOne).toHaveTextContent("Springfield, IL");
    expect(cardOne).toHaveTextContent("150 MW");

    const cardTwo = screen.getByRole("link", { name: /Site Two/ });
    expect(cardTwo).toHaveAttribute("href", "/facilities/site-two");
    expect(cardTwo).toHaveTextContent("Beta LLC");
    expect(cardTwo).toHaveTextContent("400 MW planned");
  });

  it("shows the default empty message when facilities is empty", () => {
    render(
      <CollectionPage
        title="Cancelled data center projects"
        intro="intro"
        crumbs={CRUMBS}
        statRow={[]}
        facilities={[]}
      />
    );
    expect(
      screen.getByText("No facilities currently match this view.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Site/ })).not.toBeInTheDocument();
  });

  it("shows a custom empty message when provided", () => {
    render(
      <CollectionPage
        title="Cancelled data center projects"
        intro="intro"
        crumbs={CRUMBS}
        statRow={[]}
        facilities={[]}
        emptyMessage="No cancelled projects are on file yet."
      />
    );
    expect(
      screen.getByText("No cancelled projects are on file yet.")
    ).toBeInTheDocument();
  });

  it("does not render a stat row when statRow is empty", () => {
    render(
      <CollectionPage
        title="Cancelled data center projects"
        intro="intro"
        crumbs={CRUMBS}
        statRow={[]}
        facilities={FACILITIES}
      />
    );
    expect(screen.queryByText("Sites")).not.toBeInTheDocument();
  });

  it("injects BreadcrumbList and ItemList JSON-LD script tags", () => {
    const { container } = render(
      <CollectionPage
        title="Operational data centers in the US"
        intro="intro"
        crumbs={CRUMBS}
        statRow={STAT_ROW}
        facilities={FACILITIES}
      />
    );

    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(2);
    expect(scripts[0]!.textContent).toContain('"@type":"BreadcrumbList"');
    expect(scripts[0]!.textContent).toContain("/explore");
    expect(scripts[1]!.textContent).toContain('"@type":"ItemList"');
    expect(scripts[1]!.textContent).toContain("/facilities/site-one");
  });
});
