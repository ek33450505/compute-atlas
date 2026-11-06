import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import facilitiesAliased from "@/data/facilities.json";
import metaAliased from "@/data/facilities.meta.json";
import { facilitiesSchema } from "@/lib/schema";

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
    expect(facilitiesAliased).toHaveLength(64);
    expect(metaAliased.recordCount).toBe(64);
  });
});
