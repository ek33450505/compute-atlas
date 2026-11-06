import { vi, describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("DataPage", () => {
  it("renders the h1", () => {
    const page = DataPage();
    render(page);
    expect(screen.getByRole("heading", { level: 1, name: "Get the data" })).toBeInTheDocument();
  });

  it("shows the paused notice with a contact link instead of download links", () => {
    const { container } = render(DataPage());
    expect(
      screen.getByText(/Bulk downloads of the full dataset are paused while access changes\./)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "write to us" })).toHaveAttribute("href", "/contact");
    expect(screen.queryByRole("link", { name: /Download (CSV|JSON)/ })).not.toBeInTheDocument();
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => /facilities\.(csv|json)/.test(h ?? ""))).toBe(false);
    expect(container.querySelector("a[download]")).toBeNull();
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
      expect(screen.getByText(/Bulk downloads of the full dataset are paused/)).toBeInTheDocument();
    } finally {
      vi.doUnmock("@/lib/data");
    }
  });

  it("states the pause in the meta description, within 160 characters", () => {
    expect(metadata.description).toMatch(/Bulk downloads .* are paused while access changes/);
    expect(metadata.description).not.toMatch(/CC-BY|Download the full/);
    expect((metadata.description ?? "").length).toBeLessThanOrEqual(160);
  });

  it("does not import the DB-backed data layer", () => {
    expect(readSource("app/data/page.tsx")).not.toMatch(
      /from "@\/lib\/data"|getAllFacilities\(|loadFacilities\(/
    );
  });

  it("gives the CC BY 4.0 link an accessible name that starts with its visible text", () => {
    const page = DataPage();
    render(page);
    // WCAG 2.5.3 Label in Name.
    const link = screen.getByRole("link", {
      name: "CC BY 4.0: Creative Commons Attribution 4.0 license (opens in new tab)",
    });
    expect(link).toHaveTextContent("CC BY 4.0");
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

  it("links the support page after the citation heading", () => {
    render(DataPage());
    const link = screen.getByRole("link", { name: "support keeps it running" });
    expect(link).toHaveAttribute("href", "/support");
    const heading = screen.getByRole("heading", { name: "How to cite" });
    expect(heading.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
