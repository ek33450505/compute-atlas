import { vi, describe, it, expect, afterEach } from "vitest";
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DataPage", () => {
  it("drops the /dataset sentence while sharing is off, since that page is then a not-open notice", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    render(await DataPage());
    expect(screen.queryByRole("link", { name: "Dataset page" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dataset" })).toHaveAttribute("href", "/dataset");
  });

  it("links to /dataset for the files and shows no offer even with the flags on", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    const { container } = render(await DataPage());
    expect(screen.getByRole("link", { name: "Dataset page" })).toHaveAttribute("href", "/dataset");
    expect(screen.queryByRole("heading", { name: "Free" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Commercial" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Why it costs money" })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$\d|request access|CSV columns/i);
  });

  it("renders the h1", async () => {
    const page = await DataPage();
    render(page);
    expect(screen.getByRole("heading", { level: 1, name: "Cite & license" })).toBeInTheDocument();
  });

  it("carries no bulk or API wording and no data-file links", async () => {
    const { container } = render(await DataPage());
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/download|bulk|paused|programmatic|developer docs/i);
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => /facilities\.(csv|json)|^\/api/.test(h ?? ""))).toBe(false);
    expect(container.querySelector("a[download]")).toBeNull();
  });

  it("explains how to cite an individual facility page", async () => {
    render(await DataPage());
    expect(screen.getByRole("heading", { name: "Citing a facility page" })).toBeInTheDocument();
    expect(screen.getByText(/compute-atlas\.com\/facilities\/\[id\]/)).toBeInTheDocument();
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
      render(await FreshPage());
      expect(screen.getByRole("heading", { level: 1, name: "Cite & license" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "How to cite Compute Atlas" })).toBeInTheDocument();
    } finally {
      vi.doUnmock("@/lib/data");
    }
  });

  it("titles the page Cite & license and promises no files or prices, within 160 characters", async () => {
    expect(metadata.title).toBe("Cite & license");
    expect(metadata.description).toMatch(/cite/i);
    expect(metadata.description).not.toMatch(/download|bulk|paused|\$|weekly|free for/i);
    expect((metadata.description ?? "").length).toBeLessThanOrEqual(160);
  });

  it("reads no data at all", async () => {
    const src = readSource("app/data/page.tsx");
    expect(src).not.toMatch(/from "@\/lib\/data"|getAllFacilities\(|latestPublishedEdition\(|dataset-offer/);
  });

  it("gives the CC BY 4.0 link an accessible name that starts with its visible text", async () => {
    const page = await DataPage();
    render(page);
    // WCAG 2.5.3 Label in Name.
    const link = screen.getByRole("link", {
      name: "CC BY 4.0: Creative Commons Attribution 4.0 license (opens in new tab)",
    });
    expect(link).toHaveTextContent("CC BY 4.0");
  });

  it("renders a link to /methodology", async () => {
    const page = await DataPage();
    render(page);
    expect(
      screen.getByRole("link", { name: /Read the full methodology/ })
    ).toHaveAttribute("href", "/methodology");
  });

  it("does not mention a DOI or Zenodo", async () => {
    const page = await DataPage();
    render(page);
    expect(document.body.innerHTML).not.toMatch(/zenodo|10\.5281/i);
  });

  it("gives one canonical attribution in How to cite: site link, license link, " +
    "non-partisan note", async () => {
    const page = await DataPage();
    render(page);
    const section = screen.getByRole("heading", { name: "How to cite Compute Atlas" }).closest("section");
    expect(section).not.toBeNull();
    const scoped = within(section as HTMLElement);
    expect(
      scoped.getByRole("link", { name: "https://www.compute-atlas.com (opens in new tab)" })
    ).toHaveAttribute("href", "https://www.compute-atlas.com");
    expect(
      scoped.getByRole("link", { name: "https://creativecommons.org/licenses/by/4.0/ (opens in new tab)" })
    ).toHaveAttribute("href", "https://creativecommons.org/licenses/by/4.0/");
    expect(section!.textContent).toContain("non-partisan");
    expect(section!.textContent).toContain("Link www.compute-atlas.com, Compute Atlas's home.");
    expect(section!.textContent).not.toContain("GitHub");
  });

  it("sets the canonical alternate to /data", async () => {
    expect(metadata.alternates).toEqual({ canonical: "/data" });
  });

  it("emits a BreadcrumbList JSON-LD with a valid trail of three items", async () => {
    const page = await DataPage();
    const { container } = render(page);

    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(1);

    const breadcrumb = JSON.parse(scripts[0]!.textContent!);
    expect(breadcrumb["@type"]).toBe("BreadcrumbList");
    expect(breadcrumb.itemListElement.length).toBeGreaterThanOrEqual(3);
    expect(breadcrumb.itemListElement.map((i: { position: number }) => i.position)).toEqual([
      1, 2, 3,
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
      name: "Dataset",
      item: "https://www.compute-atlas.com/dataset",
    });
    expect(breadcrumb.itemListElement[2]).toEqual({
      "@type": "ListItem",
      position: 3,
      name: "Cite & license",
      item: "https://www.compute-atlas.com/data",
    });
  });

  it("keeps raw HTML entities out of metadata string props, which JSX does not decode", async () => {
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

// One left-to-right pass: string literals match first (kept intact, so a `//` or
// `/*` inside one is not a comment and the specifiers survive); comments are dropped.
const STRING_OR_COMMENT =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

function stripComments(src: string): string {
  return src.replace(STRING_OR_COMMENT, (_m, str: string | undefined) => str ?? "");
}

const DB_SPECIFIER =
  /^(?:@\/lib\/db(?:\/|$)|drizzle-orm(?:\/|$)|@neondatabase\/|(?:\.{1,2}\/)+(?:.*\/)?db(?:\/|$))/;

/** Module specifiers in `src` (outside comments) that point at the DB client or driver. */
function dbSpecifiers(src: string): string[] {
  const code = stripComments(src);
  const found: string[] = [];
  for (const re of [
    /\bfrom\s*(["'])(.+?)\1/g,
    /\bimport\s*\(\s*(["'`])(.+?)\1/g,
    /\brequire\s*\(\s*(["'`])(.+?)\1/g,
    /^\s*import\s*(["'])(.+?)\1/gm,
  ]) {
    for (const m of code.matchAll(re)) if (DB_SPECIFIER.test(m[2])) found.push(m[2]);
  }
  return found;
}

// The facility-reading aggregate pages — each carries the "facilities" cache
// tag (see lib/cache-tags.ts) and must agree on how often it revalidates, or
// one silently drifts. /data is NOT in this list: it no longer reads facilities
// (static downloads + bundled meta), so it carries no tag; its own 86400
// declaration is asserted separately below. /table is NOT in this list either:
// it is DYNAMIC (it reads searchParams for server pagination), so it has no ISR
// timer; its data freshness comes from the 24h-cached `getAllFacilities` loader
// (asserted separately below). The
// homepage is deliberately excluded: it reads tagged data (getStats/loadFacilities)
// AND also reads untagged direct-DB data (recent activity, quarterly pipeline), so it stays on a 1h timer.
const AGGREGATE_PAGES = [
  "app/stats/page.tsx",
  "app/ai/page.tsx",
  "app/map/page.tsx",
];

describe("revalidate: /data keeps its own timer; aggregate pages agree with each other", () => {
  it("app/data/page.tsx declares revalidate = 86400", async () => {
    expect(getRevalidate("app/data/page.tsx")).toBe("86400");
  });

  it("every facility-reading aggregate page declares the same revalidate value", async () => {
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

  it("/table imports getAllFacilities and imports no DB client", async () => {
    const src = readSource("app/table/page.tsx");
    expect(src).toMatch(/^import\s*\{[^}]*\bgetAllFacilities\b[^}]*\}\s*from\s*"@\/lib\/data";/m);
    // A direct Neon read here would run on every request now that the page is dynamic.
    expect(dbSpecifiers(src)).toEqual([]);
    expect(stripComments(src)).not.toMatch(/\bgetDb\(/);
  });

  it("the DB-specifier scan catches every import form", async () => {
    const hit = (code: string) => dbSpecifiers(code).length > 0;
    expect(hit(`import { getDb } from "@/lib/db/client";`)).toBe(true);
    expect(hit(`import { getDb } from '@/lib/db';`)).toBe(true);
    expect(hit(`export { getDb } from "@/lib/db/client";`)).toBe(true);
    expect(hit(`const m = await import("@/lib/db/client");`)).toBe(true);
    expect(hit(`const m = require('drizzle-orm');`)).toBe(true);
    expect(hit(`import "@neondatabase/serverless";`)).toBe(true);
    expect(hit(`import { x } from "../lib/db/client";`)).toBe(true);
    expect(hit(`import { x } from "./db";`)).toBe(true);
    expect(hit(`import { getAllFacilities } from "@/lib/data";`)).toBe(false);
    expect(hit(`// import { getDb } from "@/lib/db/client";`)).toBe(false);
    expect(hit("const m = await import(`@/lib/db/client`);")).toBe(true);
    expect(hit("const m = require(`drizzle-orm`);")).toBe(true);
    expect(hit('// see /* note\nimport { getDb } from "@/lib/db/client";\nconst s = "*/";')).toBe(true);
    expect(hit('const u = "https://example.com"; import { getDb } from "@/lib/db/client";')).toBe(true);
    expect(hit('/* import { getDb } from "@/lib/db/client"; */')).toBe(false);
  });
});
