import { describe, it, expect } from "vitest";

import facilitiesRaw from "@/data/facilities.json";
import {
  getOperatorOwners,
  groupByOwner,
  operatorOwnership,
  operatorOwnerSchema,
  ownersFor,
  parseOperatorOwnership,
  type OperatorOwnership,
} from "@/lib/operator-ownership";

const SOURCE = {
  url: "https://example.com/filing",
  label: "Example filing",
  publisher: "Example Wire",
  retrievedAt: "2026-11-04",
  kind: "filing",
};

function ownerRow(overrides: Record<string, unknown> = {}) {
  return {
    name: "Example Capital",
    kind: "organization",
    role: "controlling_owner",
    note: "Owns the operating company.",
    source: SOURCE,
    asOf: "2026-11-04",
    ...overrides,
  };
}

const FIXTURE: OperatorOwnership[] = parseOperatorOwnership([
  {
    operator: "Fixture Cloud",
    owners: [
      ownerRow(),
      ownerRow({ name: "Fixture Infra", role: "investor", parent: "Fixture Group", stakePct: 40, since: "2022-05" }),
    ],
  },
  { operator: "Other Operator", owners: [ownerRow()] },
]);

describe("data/operator-ownership.json", () => {
  it("resolves a known row: QTS Data Centers is owned by Blackstone", () => {
    const owners = getOperatorOwners("QTS Data Centers");
    expect(owners.map((o) => o.name)).toContain("Blackstone");
    expect(owners.find((o) => o.name === "Blackstone")?.source.url).toMatch(/^https?:\/\//);
  });

  it("validates against the schema (module load parses it)", () => {
    expect(() => parseOperatorOwnership(operatorOwnership)).not.toThrow();
  });

  it("names only operators that exist in data/facilities.json", () => {
    const operators = new Set((facilitiesRaw as { operator: string }[]).map((f) => f.operator));
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

describe("operatorOwnerSchema", () => {
  it("accepts a complete row and a minimal row", () => {
    expect(operatorOwnerSchema.safeParse(ownerRow()).success).toBe(true);
    expect(
      operatorOwnerSchema.safeParse(ownerRow({ parent: "Fixture Group", stakePct: 12.5, since: "2021" })).success
    ).toBe(true);
  });

  it("rejects a row with no source", () => {
    expect(operatorOwnerSchema.safeParse(ownerRow({ source: undefined })).success).toBe(false);
  });

  it("rejects an asOf that is not a full ISO date", () => {
    expect(operatorOwnerSchema.safeParse(ownerRow({ asOf: "2026-11" })).success).toBe(false);
    expect(operatorOwnerSchema.safeParse(ownerRow({ asOf: "2026" })).success).toBe(false);
  });

  it("rejects a row with no asOf", () => {
    expect(operatorOwnerSchema.safeParse(ownerRow({ asOf: undefined })).success).toBe(false);
  });

  it("rejects a note over 300 characters", () => {
    expect(operatorOwnerSchema.safeParse(ownerRow({ note: "x".repeat(301) })).success).toBe(false);
    expect(operatorOwnerSchema.safeParse(ownerRow({ note: "x".repeat(300) })).success).toBe(true);
  });

  it("rejects a role outside controlling_owner | investor", () => {
    expect(operatorOwnerSchema.safeParse(ownerRow({ role: "lender" })).success).toBe(false);
    expect(operatorOwnerSchema.safeParse(ownerRow({ role: "founder" })).success).toBe(false);
  });

  it("rejects a person with a parent", () => {
    const result = operatorOwnerSchema.safeParse(ownerRow({ kind: "person", parent: "Some Firm" }));
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range stakePct and a malformed since", () => {
    expect(operatorOwnerSchema.safeParse(ownerRow({ stakePct: 101 })).success).toBe(false);
    expect(operatorOwnerSchema.safeParse(ownerRow({ stakePct: -1 })).success).toBe(false);
    expect(operatorOwnerSchema.safeParse(ownerRow({ since: "Aug 2021" })).success).toBe(false);
  });
});

describe("parseOperatorOwnership", () => {
  it("throws on an operator with no owners", () => {
    expect(() => parseOperatorOwnership([{ operator: "Fixture Cloud", owners: [] }])).toThrow();
  });
});

describe("ownersFor", () => {
  it("returns the owners for an exact operator match", () => {
    expect(ownersFor(FIXTURE, "Fixture Cloud").map((o) => o.name)).toEqual(["Example Capital", "Fixture Infra"]);
  });

  it("returns [] for an unknown or differently-cased operator", () => {
    expect(ownersFor(FIXTURE, "Nobody")).toEqual([]);
    expect(ownersFor(FIXTURE, "fixture cloud")).toEqual([]);
  });
});

describe("groupByOwner", () => {
  it("groups an owner across every operator it holds a stake in", () => {
    const byOwner = groupByOwner(FIXTURE);
    expect(byOwner.get("Example Capital")?.map((x) => x.operator)).toEqual(["Fixture Cloud", "Other Operator"]);
    expect(byOwner.get("Fixture Infra")?.map((x) => x.operator)).toEqual(["Fixture Cloud"]);
  });
});

describe("getOperatorOwners (real file)", () => {
  it("returns [] for an operator with no ownership rows", () => {
    expect(getOperatorOwners("An Operator That Does Not Exist")).toEqual([]);
  });
});
