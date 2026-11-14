import { describe, it, expect, afterEach, vi } from "vitest";

import { getPaletteLinks, getSiteNavGroups, NAV_LINKS } from "./site-nav";

afterEach(() => {
  vi.unstubAllEnvs();
});

function flagsOn() {
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
  vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
}

describe("getSiteNavGroups", () => {
  it("has the four groups, in order, with the five header items reachable", () => {
    flagsOn();
    const groups = getSiteNavGroups();
    expect(groups.map((g) => g.label)).toEqual(["Browse", "Explore", "Dataset", "About"]);
    const hrefs = groups.flatMap((g) => g.links.map((l) => l.href));
    for (const { href } of NAV_LINKS) expect(hrefs).toContain(href);
  });

  it("lists the Dataset group with Commercial, Free and Cite & license while the flags are on", () => {
    flagsOn();
    const dataset = getSiteNavGroups().find((g) => g.label === "Dataset")!;
    expect(dataset.links).toEqual([
      { label: "Dataset", href: "/dataset" },
      { label: "Dataset subscription", href: "/access/commercial" },
      { label: "Free access for students", href: "/access" },
      { label: "Cite & license", href: "/data" },
    ]);
  });

  it("drops the access links while sharing is off, keeping Dataset and Cite & license", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    const dataset = getSiteNavGroups().find((g) => g.label === "Dataset")!;
    expect(dataset.links.map((l) => l.href)).toEqual(["/dataset", "/data"]);
  });

  it("drops only the commercial link while the commercial tier is off", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "");
    const dataset = getSiteNavGroups().find((g) => g.label === "Dataset")!;
    expect(dataset.links.map((l) => l.href)).toEqual(["/dataset", "/access", "/data"]);
  });

  it("puts Stats and Activity under Explore and the project pages under About, externals last", () => {
    flagsOn();
    const groups = getSiteNavGroups();
    const explore = groups.find((g) => g.label === "Explore")!.links.map((l) => l.href);
    expect(explore).toEqual(expect.arrayContaining(["/explore", "/stats", "/activity"]));
    const about = groups.find((g) => g.label === "About")!.links;
    expect(about.map((l) => l.label)).toEqual([
      "About",
      "Methodology",
      "Contribute",
      "Contributors",
      "Support",
      "Contact",
      "Source on GitHub",
      "Bluesky",
      "Newsletter",
    ]);
    expect(about.filter((l) => l.external).map((l) => l.label)).toEqual([
      "Source on GitHub",
      "Bluesky",
      "Newsletter",
    ]);
  });
});

describe("getPaletteLinks", () => {
  it("has each internal href once and no external links", () => {
    flagsOn();
    const links = getPaletteLinks();
    const hrefs = links.map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.every((h) => h.startsWith("/"))).toBe(true);
    expect(hrefs).toEqual(expect.arrayContaining(["/stats", "/activity", "/contribute", "/support"]));
    expect(links.find((l) => l.href === "/explore")?.label).toBe("Explore");
  });
});
