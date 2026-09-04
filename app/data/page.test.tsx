import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import type { DataCenterFacility } from "@/lib/schema";
import type { DatasetEdition } from "@/lib/dataset-edition";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts (same
// pattern as app/states/page.test.tsx, app/stakeholders/[person]/page.test.tsx).
const { mockGetAllFacilities, mockGetDatasetEdition } = vi.hoisted(() => ({
  mockGetAllFacilities: vi.fn(),
  mockGetDatasetEdition: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getAllFacilities: mockGetAllFacilities,
}));

vi.mock("@/lib/dataset-edition", () => ({
  getDatasetEdition: mockGetDatasetEdition,
}));

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

import DataPage, { metadata } from "./page";

function makeFacility(overrides: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Acme Corp",
    status: "operational",
    confidence: "confirmed",
    facilityType: "data_center",
    location: { lat: 40, lon: -90, city: "Springfield", state: "IL", precision: "exact" },
    statusHistory: [],
    sources: [
      { url: "https://example.com", label: "Example source", retrievedAt: "2026-01-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  };
}

const FIXTURE_FACILITIES: DataCenterFacility[] = [
  makeFacility({ id: "facility-1", name: "Facility One" }),
  makeFacility({ id: "facility-2", name: "Facility Two" }),
  makeFacility({ id: "facility-3", name: "Facility Three" }),
];

const FIXTURE_EDITION: DatasetEdition = {
  version: "1.31.0",
  asOf: "2026-08-15T00:00:00.000Z",
  recordCount: 3,
  schemaVersion: 4,
};

beforeEach(() => {
  mockGetAllFacilities.mockReset();
  mockGetDatasetEdition.mockReset();
  mockGetAllFacilities.mockResolvedValue(FIXTURE_FACILITIES);
  mockGetDatasetEdition.mockReturnValue(FIXTURE_EDITION);
});

describe("DataPage", () => {
  it("renders the h1", async () => {
    const page = await DataPage();
    render(page);
    expect(screen.getByRole("heading", { level: 1, name: "Get the data" })).toBeInTheDocument();
  });

  it("renders the download buttons with aria-labels reflecting the fixture facility count", async () => {
    const page = await DataPage();
    render(page);
    expect(
      screen.getByRole("button", { name: "Download 3 facilities as CSV" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download 3 facilities as JSON" })
    ).toBeInTheDocument();
  });

  it("renders a link to /methodology", async () => {
    const page = await DataPage();
    render(page);
    expect(
      screen.getByRole("link", { name: /Read the full methodology/ })
    ).toHaveAttribute("href", "/methodology");
  });

  it("renders a link to /api", async () => {
    const page = await DataPage();
    render(page);
    expect(screen.getByRole("link", { name: /developer docs/ })).toHaveAttribute(
      "href",
      "/api"
    );
  });

  it("renders the DOI link", async () => {
    const page = await DataPage();
    render(page);
    const doiLinks = screen.getAllByRole("link", {
      name: "https://doi.org/10.5281/zenodo.22284476",
    });
    expect(doiLinks.length).toBeGreaterThan(0);
    for (const link of doiLinks) {
      expect(link).toHaveAttribute("href", "https://doi.org/10.5281/zenodo.22284476");
    }
  });

  it("sets the canonical alternate to /data", () => {
    expect(metadata.alternates).toEqual({ canonical: "/data" });
  });

  it("emits a BreadcrumbList JSON-LD with a valid trail of at least two items", async () => {
    const page = await DataPage();
    const { container } = render(page);

    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(1);

    const breadcrumb = JSON.parse(scripts[0]!.textContent!);
    expect(breadcrumb["@type"]).toBe("BreadcrumbList");
    expect(breadcrumb.itemListElement.length).toBeGreaterThanOrEqual(2);
    expect(breadcrumb.itemListElement.map((i: { position: number }) => i.position)).toEqual([
      1, 2,
    ]);
    expect(breadcrumb.itemListElement[0]).toEqual({
      "@type": "ListItem",
      position: 1,
      name: "Home",
      item: "https://www.compute-atlas.com/",
    });
    expect(breadcrumb.itemListElement[1]).toEqual({
      "@type": "ListItem",
      position: 2,
      name: "Get the data",
      item: "https://www.compute-atlas.com/data",
    });
  });

  it("keeps raw HTML entities out of metadata string props, which JSX does not decode", () => {
    const strings = [metadata.title, metadata.description].filter(
      (v): v is string => typeof v === "string"
    );
    expect(strings.length).toBeGreaterThan(0);
    for (const s of strings) {
      expect(s).not.toMatch(/&(mdash|ndash|rsquo|lsquo|middot|amp|nbsp);/);
    }
  });
});
