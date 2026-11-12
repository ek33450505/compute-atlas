import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/data", () => ({
  getAllFacilities: vi.fn(),
  getStakeholders: vi.fn(),
  getStates: vi.fn(),
  getOperators: vi.fn(),
  operatorSlug: vi.fn(),
  getFacilitiesByMetro: vi.fn(),
  getCounties: vi.fn(),
  getFacilitiesByCounty: vi.fn(),
}));

import {
  buildStakeholderRoutes,
  MIN_FACILITIES_FOR_STAKEHOLDER_SITEMAP,
} from "@/lib/sitemap-routes";
import { getAllFacilities, getStakeholders } from "@/lib/data";
import { siteConfig } from "@/lib/site";

type Person = Awaited<ReturnType<typeof getStakeholders>>[number];
type Facilities = Awaited<ReturnType<typeof getAllFacilities>>;

function fac(id: string, operator: string, stakeholderNames: string[] = []) {
  return {
    id,
    operator,
    lastUpdated: "2026-10-01T00:00:00Z",
    stakeholders: stakeholderNames.map((name) => ({ name })),
  };
}

function person(slug: string, name: string, viaOperators: string[] = []) {
  return { slug, name, viaOperators: viaOperators.map((operator) => ({ operator })) };
}

function setup(people: ReturnType<typeof person>[], facilities: ReturnType<typeof fac>[]) {
  vi.mocked(getStakeholders).mockResolvedValue(people as unknown as Person[]);
  vi.mocked(getAllFacilities).mockResolvedValue(facilities as unknown as Facilities);
}

const urlOf = (slug: string) => `${siteConfig.url}/stakeholders/${slug}`;

describe("buildStakeholderRoutes minimum-site filter", () => {
  beforeEach(() => vi.resetAllMocks());

  it("the minimum is 2", () => {
    expect(MIN_FACILITIES_FOR_STAKEHOLDER_SITEMAP).toBe(2);
  });

  it("excludes a person with one site-level facility", async () => {
    setup([person("solo", "Solo")], [fac("a", "Op1", ["Solo"])]);
    const urls = (await buildStakeholderRoutes()).map((r) => r.url);
    expect(urls).not.toContain(urlOf("solo"));
  });

  it("includes a person with two site-level facilities", async () => {
    setup([person("duo", "Duo")], [fac("a", "Op1", ["Duo"]), fac("b", "Op2", ["Duo"])]);
    const urls = (await buildStakeholderRoutes()).map((r) => r.url);
    expect(urls).toContain(urlOf("duo"));
  });

  it("includes a person with one site-level plus one via-operator facility", async () => {
    setup(
      [person("mix", "Mix", ["OwnedCo"])],
      [fac("a", "Op1", ["Mix"]), fac("b", "OwnedCo")]
    );
    const urls = (await buildStakeholderRoutes()).map((r) => r.url);
    expect(urls).toContain(urlOf("mix"));
  });

  it("counts a facility that is both site-level and via-operator once", async () => {
    setup([person("dup", "Dup", ["OwnedCo"])], [fac("a", "OwnedCo", ["Dup"])]);
    const urls = (await buildStakeholderRoutes()).map((r) => r.url);
    expect(urls).not.toContain(urlOf("dup"));
  });

  it("always keeps the /stakeholders index entry", async () => {
    setup([person("solo", "Solo")], [fac("a", "Op1", ["Solo"])]);
    const urls = (await buildStakeholderRoutes()).map((r) => r.url);
    expect(urls).toEqual([`${siteConfig.url}/stakeholders`]);
  });
});
