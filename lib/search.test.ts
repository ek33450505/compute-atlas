import { describe, it, expect, beforeAll } from "vitest";
import { getAllFacilities, getOperators } from "@/lib/data";
import {
  buildSearchIndex,
  searchCommands,
  type SearchEntry,
} from "@/lib/search";
import type { Facility } from "@/lib/schema";

describe("buildSearchIndex", () => {
  let index: SearchEntry[];

  beforeAll(async () => {
    index = await buildSearchIndex();
  });

  it("includes exactly one entry per facility", async () => {
    const facilityEntries = index.filter((e) => e.type === "facility");
    expect(facilityEntries.length).toBe((await getAllFacilities()).length);
  });

  it("includes exactly one entry per operator", async () => {
    const operatorEntries = index.filter((e) => e.type === "operator");
    expect(operatorEntries.length).toBe((await getOperators()).length);
  });

  it("every entry has a non-empty label and an href starting with /", () => {
    for (const entry of index) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.href.startsWith("/")).toBe(true);
    }
  });

  it("every state entry href is /states/<non-empty-slug>", () => {
    const stateEntries = index.filter((e) => e.type === "state");
    expect(stateEntries.length).toBeGreaterThan(0);
    for (const entry of stateEntries) {
      expect(entry.href).toMatch(/^\/states\/.+$/);
    }
  });
});

describe("searchCommands — empty query (quick nav)", () => {
  const pageEntries: SearchEntry[] = [
    { type: "page", label: "Home", href: "/", keywords: "home" },
    { type: "page", label: "Map", href: "/map", keywords: "map" },
  ];

  it("returns exactly the page group when page entries are included", () => {
    const groups = searchCommands(pageEntries, "");
    expect(groups.length).toBe(1);
    expect(groups[0].type).toBe("page");
    expect(groups[0].items).toEqual(pageEntries);
  });

  it("returns [] for a data-only index (no page entries)", async () => {
    const dataOnly = await buildSearchIndex();
    const groups = searchCommands(dataOnly, "");
    expect(groups).toEqual([]);
  });

  it("treats a whitespace-only query the same as empty", () => {
    const groups = searchCommands(pageEntries, "   ");
    expect(groups.length).toBe(1);
    expect(groups[0].type).toBe("page");
  });
});

describe("searchCommands — ranked search", () => {
  let index: SearchEntry[];
  let knownFacility: Facility;

  beforeAll(async () => {
    index = await buildSearchIndex();
    knownFacility = (await getAllFacilities())[0];
  });

  it("a facility-name substring surfaces a group whose items include that facility", () => {
    const groups = searchCommands(index, knownFacility.name);
    const facilityGroup = groups.find((g) => g.type === "facility");
    expect(facilityGroup).toBeDefined();
    expect(
      facilityGroup!.items.some((item) => item.href === `/facilities/${knownFacility.id}`)
    ).toBe(true);
  });

  it("respects per-group caps", () => {
    // A single-letter query is broad enough to exceed small caps across
    // multiple entry types.
    const groups = searchCommands(index, "a", {
      facility: 2,
      operator: 1,
      state: 1,
    });
    for (const group of groups) {
      if (group.type === "facility") expect(group.items.length).toBeLessThanOrEqual(2);
      if (group.type === "operator") expect(group.items.length).toBeLessThanOrEqual(1);
      if (group.type === "state") expect(group.items.length).toBeLessThanOrEqual(1);
    }
  });

  it("drops empty groups", () => {
    const groups = searchCommands(index, knownFacility.name);
    for (const group of groups) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });
});
