import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import facilitiesAliased from "@/data/facilities.json";
import metaAliased from "@/data/facilities.meta.json";
import { facilitiesSchema } from "@/lib/schema";

import { ALIASED_DATA_FILES } from "./aliased-data-files";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(__dirname, name), "utf-8"));

describe("test fixtures", () => {
  const facilities = facilitiesSchema.parse(read("facilities.fixture.json"));

  it("every facility record validates against facilitySchema", () => {
    expect(facilitiesSchema.safeParse(read("facilities.fixture.json")).success).toBe(true);
  });

  it("has unique ids", () => {
    expect(new Set(facilities.map((f) => f.id)).size).toBe(facilities.length);
  });

  it("covers every facility type", () => {
    expect(new Set(facilities.map((f) => f.facilityType))).toEqual(
      new Set(["data_center", "crypto_mining", "power_generation"])
    );
  });

  it("includes the kinds some lib tests need to be non-vacuous", () => {
    const inFixture = (p: (f: (typeof facilities)[number]) => boolean) => facilities.filter(p);
    const positiveMgd = inFixture((f) => f.status !== "cancelled" && (f.water?.reportedMgd ?? 0) > 0);
    expect(positiveMgd.length).toBeGreaterThanOrEqual(2);
    expect(inFixture((f) => !f.location.county).length).toBeGreaterThan(0);
    const friction = ["contested", "opposed", "litigation"];
    expect(
      inFixture((f) => f.status === "cancelled" && !!f.community && !friction.includes(f.community.status ?? ""))
        .length
    ).toBeGreaterThan(0);
  });

  it("every poweredFacilityIds entry resolves inside the fixture", () => {
    const ids = new Set(facilities.map((f) => f.id));
    for (const f of facilities) {
      const powered = (f as { generation?: { poweredFacilityIds?: string[] } }).generation?.poweredFacilityIds;
      for (const id of powered ?? []) expect(ids.has(id)).toBe(true);
    }
  });

  it("meta recordCount matches the fixture length", () => {
    expect((read("facilities.meta.fixture.json") as { recordCount: number }).recordCount).toBe(
      facilities.length
    );
  });

  it("siting-context entries belong to fixture facilities", () => {
    const ids = new Set(facilities.map((f) => f.id));
    for (const id of Object.keys(read("siting-context.fixture.json") as object)) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("vitest aliases @/data/*.json to the fixtures (a broken alias fails loudly)", () => {
    expect(facilitiesAliased).toHaveLength(metaAliased.recordCount);
    expect(facilitiesAliased).toHaveLength(facilities.length);
    // the real dataset has thousands of records; a sample this small proves the alias is on
    expect(facilitiesAliased.length).toBeGreaterThanOrEqual(60);
    expect(facilitiesAliased.length).toBeLessThan(200);
  });

  it("no source file imports an @/data/*.json that the vitest alias does not cover", () => {
    const root = path.resolve(__dirname, "../..");
    const found = new Map<string, string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        // *.dataset.test.ts files run only with DATASET=real, against real data by design.
        else if (/\.(tsx?|mjs)$/.test(entry.name) && !/\.dataset\.test\.ts$/.test(entry.name)) {
          const src = readFileSync(full, "utf-8");
          for (const m of src.matchAll(/(?:from\s*|import\s*\(?\s*|require\(\s*)["']@\/data\/([^"']+\.json)["']/g)) {
            found.set(m[1], path.relative(root, full));
          }
        }
      }
    };
    for (const dir of ["app", "lib", "components", "scripts"]) walk(path.join(root, dir));

    // Not vacuous: the scan must actually see the data imports.
    expect(found.size).toBeGreaterThan(0);
    const aliased: readonly string[] = ALIASED_DATA_FILES;
    const uncovered = [...found].filter(([name]) => !aliased.includes(name));
    expect(uncovered).toEqual([]);
  });
});
