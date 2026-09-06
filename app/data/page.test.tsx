import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Regression guard for the /data staleness bug (2026-09-05): app/data/page.tsx
 * was the only facility-reading aggregate page with no `export const
 * revalidate`, so it silently inherited the root layout's 86400s (24h) floor
 * instead of the 3600s (1h) timer every sibling aggregate page uses — its
 * download-count aria-label lagged prod by 21 facilities with no error.
 *
 * These pages are async server components with their own DB-reading and
 * heavy-component (Explorer, MapLibre) dependency trees, so importing them
 * directly here would mean mocking each one's tree just to read a single
 * top-level export. Reading the source text and parsing the `export const
 * revalidate` literal (same approach as lib/search-index.guard.test.ts)
 * decouples this guard from each page's implementation.
 */
function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

// Matches `export const revalidate = <value>;` and captures <value> — a bare
// integer (seconds) or the literal `false` (Next.js's "never revalidate").
const REVALIDATE_EXPORT = /^export const revalidate = (\d+|false);$/m;

/** Returns a page's declared `revalidate` value as a string, or null if absent. */
function getRevalidate(relativePath: string): string | null {
  const match = readSource(relativePath).match(REVALIDATE_EXPORT);
  return match ? match[1] : null;
}

// The facility-reading aggregate pages that must self-heal within the hour —
// each carries the "facilities" cache tag (see lib/cache-tags.ts) and must
// agree on how often it revalidates, or one silently drifts onto the 24h
// root-layout floor the way /data did.
const AGGREGATE_PAGES = [
  "app/page.tsx",
  "app/stats/page.tsx",
  "app/table/page.tsx",
  "app/ai/page.tsx",
  "app/map/page.tsx",
  "app/data/page.tsx",
];

describe("revalidate: /data must not drift from its aggregate-page siblings", () => {
  it("app/data/page.tsx declares revalidate = 3600", () => {
    expect(getRevalidate("app/data/page.tsx")).toBe("3600");
  });

  it("every facility-reading aggregate page declares the same revalidate value", () => {
    const values = AGGREGATE_PAGES.map((path) => ({ path, value: getRevalidate(path) }));

    // Sanity check on the extraction itself, mirroring
    // lib/search-index.guard.test.ts: if the regex stopped matching every
    // page's declaration, all values would be null and the "all equal"
    // assertion below would pass vacuously.
    for (const { path, value } of values) {
      expect(value, `${path} is missing an "export const revalidate" declaration`).not.toBeNull();
    }

    const distinctValues = new Set(values.map((v) => v.value));
    expect(
      distinctValues.size,
      `revalidate values diverge across aggregate pages: ${JSON.stringify(values)}`
    ).toBe(1);
  });
});
