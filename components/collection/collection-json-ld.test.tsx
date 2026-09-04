import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import type { Facility } from "@/lib/schema";
import { CollectionJsonLd } from "./collection-json-ld";

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
      { url: "https://example.com", label: "Example source", retrievedAt: "2025-01-01", kind: "press" },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

const CRUMBS = [
  { label: "Explore", href: "/explore" },
  { label: "States", href: "/states" },
  { label: "Illinois" },
];

const FACILITIES = [
  makeFacility(),
  makeFacility({ id: "site-two", name: "Site Two" }),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CollectionJsonLd", () => {
  it("renders exactly a BreadcrumbList script and an ItemList script", () => {
    const { container } = render(
      <CollectionJsonLd crumbs={CRUMBS} facilities={FACILITIES} />
    );

    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(2);
    expect(scripts[0]!.textContent).toContain('"@type":"BreadcrumbList"');
    expect(scripts[1]!.textContent).toContain('"@type":"ItemList"');
  });

  it("maps crumb label/href to BreadcrumbList name/item, omitting item for a crumb with no href", () => {
    const { container } = render(
      <CollectionJsonLd crumbs={CRUMBS} facilities={FACILITIES} />
    );
    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    const breadcrumbJson = JSON.parse(scripts[0]!.textContent!.replace(/\\u003c/g, "<"));

    expect(breadcrumbJson.itemListElement).toHaveLength(3);
    expect(breadcrumbJson.itemListElement[0]).toMatchObject({
      name: "Explore",
      item: expect.stringContaining("/explore"),
    });
    // Last crumb has no href — must omit `item` entirely, not set it undefined/null.
    expect(breadcrumbJson.itemListElement[2]).toEqual({
      "@type": "ListItem",
      position: 3,
      name: "Illinois",
    });
  });

  it("maps each facility's id/name into an absolute /facilities/<id> ItemList entry", () => {
    const { container } = render(
      <CollectionJsonLd crumbs={CRUMBS} facilities={FACILITIES} />
    );
    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    const itemListJson = JSON.parse(scripts[1]!.textContent!.replace(/\\u003c/g, "<"));

    expect(itemListJson.numberOfItems).toBe(2);
    expect(itemListJson.itemListElement[0]).toMatchObject({
      name: "Site One",
      url: expect.stringContaining("/facilities/site-one"),
    });
    expect(itemListJson.itemListElement[1]).toMatchObject({
      name: "Site Two",
      url: expect.stringContaining("/facilities/site-two"),
    });
  });

  it("renders an empty ItemList when facilities is empty", () => {
    const { container } = render(
      <CollectionJsonLd crumbs={CRUMBS} facilities={[]} />
    );
    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    const itemListJson = JSON.parse(scripts[1]!.textContent!.replace(/\\u003c/g, "<"));
    expect(itemListJson.numberOfItems).toBe(0);
    expect(itemListJson.itemListElement).toEqual([]);
  });
});
