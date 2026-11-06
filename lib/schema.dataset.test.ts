import { describe, it, expect } from "vitest";
import facilitiesRaw from "@/data/facilities.json";
import { OFFTAKER_LABEL_PATTERN } from "@/lib/schema";

// Real-dataset half (DATASET=real) of the offtaker-pattern test in schema.test.ts.
describe("OFFTAKER_LABEL_PATTERN", () => {
  it("every offtaker in data/facilities.json matches the pattern", () => {
    const bad = (facilitiesRaw as unknown as Array<{ id: string; generation?: { offtaker?: string } }>)
      .filter((f) => typeof f.generation?.offtaker === "string")
      .filter((f) => !OFFTAKER_LABEL_PATTERN.test(f.generation!.offtaker!))
      .map((f) => `${f.id}: ${f.generation!.offtaker}`);
    expect(bad).toEqual([]);
  });
});
