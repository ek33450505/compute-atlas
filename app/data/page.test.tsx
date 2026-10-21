import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DatasetEdition } from "@/lib/dataset-edition";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts (same
// pattern as app/states/page.test.tsx, app/stakeholders/[person]/page.test.tsx).
const { mockGetDatasetEdition } = vi.hoisted(() => ({
  mockGetDatasetEdition: vi.fn(),
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

const FIXTURE_EDITION: DatasetEdition = {
  version: "1.31.0",
  asOf: "2026-08-15T12:00:00.000Z",
  recordCount: 3,
  schemaVersion: 4,
};

beforeEach(() => {
  mockGetDatasetEdition.mockReset();
  mockGetDatasetEdition.mockReturnValue(FIXTURE_EDITION);
});

describe("DataPage", () => {
  it("renders the h1", () => {
    const page = DataPage();
    render(page);
    expect(screen.getByRole("heading", { level: 1, name: "Get the data" })).toBeInTheDocument();
  });

  it("renders versioned static download links with the count in the accessible name", () => {
    render(DataPage());
    const csv = screen.getByRole("link", { name: "Download CSV: all 3 facilities" });
    const version = encodeURIComponent(FIXTURE_EDITION.asOf);
    expect(csv).toHaveAttribute("href", `/data/facilities.csv?v=${version}`);
    expect(csv).toHaveAttribute("download", "compute-atlas-facilities.csv");
    const json = screen.getByRole("link", { name: "Download JSON: all 3 facilities" });
    expect(json).toHaveAttribute("href", `/data/facilities.json?v=${version}`);
    expect(json).toHaveAttribute("download", "compute-atlas-facilities.json");
  });

  it("omits the version and the as-of claim when the edition date is unusable", () => {
    mockGetDatasetEdition.mockReturnValue({ ...FIXTURE_EDITION, asOf: "unknown" });
    render(DataPage());
    expect(screen.getByRole("link", { name: /Download CSV/ })).toHaveAttribute(
      "href",
      "/data/facilities.csv"
    );
    expect(screen.queryByText(/as of/)).not.toBeInTheDocument();
  });

  it("renders even if the DB-backed data layer throws on any use", async () => {
    vi.resetModules();
    vi.doMock("@/lib/data", () => {
      const boom = () => {
        throw new Error("data layer must not be touched by /data");
      };
      return { getAllFacilities: boom, loadFacilities: boom };
    });
    try {
      const { default: FreshPage } = await import("./page");
      render(FreshPage());
      expect(screen.getByRole("heading", { level: 1, name: "Get the data" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Download CSV/ })).toBeInTheDocument();
    } finally {
      vi.doUnmock("@/lib/data");
    }
  });

  it("states that the downloads are a deploy-time snapshot that can trail the live site", () => {
    render(DataPage());
    expect(
      screen.getByText(
        new RegExp(
          "Both files are a snapshot as of August 15, 2026, published with each site deploy\\. " +
            "They can trail the live site until the next deploy\\."
        )
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/same one counted above|same snapshot|regenerated/)
    ).not.toBeInTheDocument();
  });

  it("drops the date but keeps the snapshot caveat when the edition date is unusable", () => {
    mockGetDatasetEdition.mockReturnValue({ ...FIXTURE_EDITION, asOf: "unknown" });
    render(DataPage());
    expect(
      screen.getByText(/Both files are a snapshot published with each site deploy\. They can trail/)
    ).toBeInTheDocument();
  });

  it("qualifies the meta description as the deployed snapshot", () => {
    expect(metadata.description).toBe(
      "Download the full Compute Atlas dataset free under CC-BY-4.0 — every tracked facility " +
        "in the deployed snapshot, no login, no sign-up, no query building."
    );
    expect((metadata.description ?? "").length).toBeLessThanOrEqual(160);
  });

  it("shows the snapshot count and as-of date from the bundled edition", () => {
    render(DataPage());
    expect(screen.getByText(/3 facilities, as of August 15, 2026/)).toBeInTheDocument();
  });

  it("does not import the DB-backed data layer", () => {
    expect(readSource("app/data/page.tsx")).not.toMatch(
      /from "@\/lib\/data"|getAllFacilities\(|loadFacilities\(/
    );
  });

  it("renders a link to /methodology", () => {
    const page = DataPage();
    render(page);
    expect(
      screen.getByRole("link", { name: /Read the full methodology/ })
    ).toHaveAttribute("href", "/methodology");
  });

  it("renders a link to /api", () => {
    const page = DataPage();
    render(page);
    expect(screen.getByRole("link", { name: /developer docs/ })).toHaveAttribute(
      "href",
      "/api"
    );
  });

  it("renders the DOI link", () => {
    const page = DataPage();
    render(page);
    const doiLinks = screen.getAllByRole("link", {
      name: "https://doi.org/10.5281/zenodo.22284476",
    });
    expect(doiLinks.length).toBeGreaterThan(0);
    for (const link of doiLinks) {
      expect(link).toHaveAttribute("href", "https://doi.org/10.5281/zenodo.22284476");
    }
  });

  it("gives one canonical attribution in How to cite: site link, license link, " +
    "non-partisan note", () => {
    const page = DataPage();
    render(page);
    const section = screen.getByRole("heading", { name: "How to cite" }).closest("section");
    expect(section).not.toBeNull();
    const scoped = within(section as HTMLElement);
    expect(
      scoped.getByRole("link", { name: "https://www.compute-atlas.com (opens in new tab)" })
    ).toHaveAttribute("href", "https://www.compute-atlas.com");
    expect(
      scoped.getByRole("link", { name: "https://creativecommons.org/licenses/by/4.0/ (opens in new tab)" })
    ).toHaveAttribute("href", "https://creativecommons.org/licenses/by/4.0/");
    expect(section!.textContent).toContain("non-partisan");
    expect(section!.textContent).toContain("rather than the GitHub repository");
  });

  it("sets the canonical alternate to /data", () => {
    expect(metadata.alternates).toEqual({ canonical: "/data" });
  });

  it("emits a BreadcrumbList JSON-LD with a valid trail of at least two items", () => {
    const page = DataPage();
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

// The facility-reading aggregate pages — each carries the "facilities" cache
// tag (see lib/cache-tags.ts) and must agree on how often it revalidates, or
// one silently drifts. /data is NOT in this list: it no longer reads facilities
// (static downloads + bundled meta), so it carries no tag; its own 86400
// declaration is asserted separately below. The
// homepage is deliberately excluded: it reads tagged data (getStats/loadFacilities)
// AND also reads untagged direct-DB data (recent activity, quarterly pipeline), so it stays on a 1h timer.
const AGGREGATE_PAGES = [
  "app/stats/page.tsx",
  "app/table/page.tsx",
  "app/ai/page.tsx",
  "app/map/page.tsx",
];

describe("revalidate: /data keeps its own timer; aggregate pages agree with each other", () => {
  it("app/data/page.tsx declares revalidate = 86400", () => {
    expect(getRevalidate("app/data/page.tsx")).toBe("86400");
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
