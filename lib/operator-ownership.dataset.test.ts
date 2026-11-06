import { describe, it, expect } from "vitest";

import facilitiesRaw from "@/data/facilities.json";
import { operatorOwnership, parseOperatorOwnership } from "@/lib/operator-ownership";

// Real-dataset half (DATASET=real) of "data/operator-ownership.json" in
// operator-ownership.test.ts, which runs the same checks on the fixture.
describe("data/operator-ownership.json (real)", () => {
  it("validates against the schema (module load parses it)", () => {
    expect(() => parseOperatorOwnership(operatorOwnership)).not.toThrow();
  });

  it("names only operators that exist in data/facilities.json", () => {
    const operators = new Set((facilitiesRaw as { operator: string }[]).map((f) => f.operator));
    expect(operators.size).toBeGreaterThan(100);
    const unknown = operatorOwnership.map((o) => o.operator).filter((op) => !operators.has(op));
    expect(unknown).toEqual([]);
  });

  it("has no duplicate operator and no duplicate (operator, owner) pair", () => {
    const operators = operatorOwnership.map((o) => o.operator);
    expect(new Set(operators).size).toBe(operators.length);
    const pairs = operatorOwnership.flatMap((o) => o.owners.map((w) => `${o.operator}\u0000${w.name}`));
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
