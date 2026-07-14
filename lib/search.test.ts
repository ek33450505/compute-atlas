import { describe, it, expect, beforeAll } from "vitest";
import { getAllFacilities, getOperators } from "@/lib/data";
import {
  buildSearchIndex,
  searchCommands,
  facilityToSearchEntry,
  mergeFacilityResults,
  type SearchEntry,
  type SearchResultGroup,
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

describe("facilityToSearchEntry", () => {
  function makeFacility(overrides: Partial<Facility["location"]> = {}): Facility {
    return {
      id: "acme-campus",
      name: "Acme Campus",
      operator: "Acme Corp",
      status: "operational",
      confidence: "confirmed",
      facilityType: "data_center",
      location: {
        lat: 39.0,
        lon: -77.0,
        state: "VA",
        county: "Loudoun",
        ...overrides,
      },
    } as Facility;
  }

  it("builds a facility entry with a city, StateName sublabel", () => {
    const facility = makeFacility({ city: "Ashburn" });
    const entry = facilityToSearchEntry(facility);

    expect(entry).toMatchObject({
      type: "facility",
      label: "Acme Campus",
      href: "/facilities/acme-campus",
      sublabel: "Ashburn, Virginia",
    });
    expect(entry.keywords).toContain("acme corp");
    expect(entry.keywords).toContain("loudoun");
    expect(entry.keywords).toBe(entry.keywords.toLowerCase());
  });

  it("falls back to just the state name when there's no city", () => {
    const facility = makeFacility({});
    const entry = facilityToSearchEntry(facility);

    expect(entry.sublabel).toBe("Virginia");
  });
});

describe("mergeFacilityResults", () => {
  const pageGroup: SearchResultGroup = {
    type: "page",
    label: "Pages",
    items: [{ type: "page", label: "Home", href: "/", keywords: "home" }],
  };
  const facilityGroup: SearchResultGroup = {
    type: "facility",
    label: "Facilities",
    items: [
      { type: "facility", label: "Existing A", href: "/facilities/existing-a", keywords: "" },
    ],
  };
  const operatorGroup: SearchResultGroup = {
    type: "operator",
    label: "Operators",
    items: [{ type: "operator", label: "Acme Corp", href: "/operators/acme-corp", keywords: "" }],
  };
  const stateGroup: SearchResultGroup = {
    type: "state",
    label: "States",
    items: [{ type: "state", label: "Virginia", href: "/states/virginia", keywords: "" }],
  };

  function dbEntry(href: string, label = href): SearchEntry {
    return { type: "facility", label, href, keywords: "" };
  }

  it("returns groups unchanged when dbEntries is empty", () => {
    const groups = [pageGroup, facilityGroup];
    expect(mergeFacilityResults(groups, [])).toBe(groups);
  });

  it("dedups by href — a DB entry matching an existing facility href is not duplicated", () => {
    const merged = mergeFacilityResults(
      [facilityGroup],
      [dbEntry("/facilities/existing-a", "Existing A (DB)")]
    );
    const facilities = merged.find((g) => g.type === "facility")!;
    expect(facilities.items.length).toBe(1);
    expect(facilities.items[0].label).toBe("Existing A");
  });

  it("appends unique DB entries after existing facility items", () => {
    const merged = mergeFacilityResults([facilityGroup], [dbEntry("/facilities/new-b", "New B")]);
    const facilities = merged.find((g) => g.type === "facility")!;
    expect(facilities.items.map((i) => i.href)).toEqual([
      "/facilities/existing-a",
      "/facilities/new-b",
    ]);
  });

  it("respects the cap", () => {
    const dbEntries = [dbEntry("/facilities/b"), dbEntry("/facilities/c"), dbEntry("/facilities/d")];
    const merged = mergeFacilityResults([facilityGroup], dbEntries, 2);
    const facilities = merged.find((g) => g.type === "facility")!;
    expect(facilities.items.length).toBe(2);
  });

  it("inserts a facility group in GROUP_ORDER position when Fuse had none but DB entries exist", () => {
    const merged = mergeFacilityResults([pageGroup, operatorGroup, stateGroup], [dbEntry("/facilities/new-b", "New B")]);
    expect(merged.map((g) => g.type)).toEqual(["page", "facility", "operator", "state"]);
  });

  it("leaves page/operator/state groups and their order untouched", () => {
    const merged = mergeFacilityResults(
      [pageGroup, facilityGroup, operatorGroup, stateGroup],
      [dbEntry("/facilities/new-b", "New B")]
    );
    expect(merged.find((g) => g.type === "page")).toBe(pageGroup);
    expect(merged.find((g) => g.type === "operator")).toBe(operatorGroup);
    expect(merged.find((g) => g.type === "state")).toBe(stateGroup);
    expect(merged.map((g) => g.type)).toEqual(["page", "facility", "operator", "state"]);
  });
});
