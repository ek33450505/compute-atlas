import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import facilitiesRaw from "@/data/facilities.json";
import {
  getOperatorOwners,
  groupByOwner,
  loadAllOperatorOwnershipUncached,
  loadOperatorOwnershipUncached,
  type OperatorOwnershipSource,
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
  it("resolves a known row: QTS Data Centers is owned by Blackstone", async () => {
    const owners = await getOperatorOwners("QTS Data Centers");
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
  it("returns [] for an operator with no ownership rows", async () => {
    expect(await getOperatorOwners("An Operator That Does Not Exist")).toEqual([]);
  });
});

function fakeSource(overrides: Partial<OperatorOwnershipSource> = {}): OperatorOwnershipSource {
  return {
    one: async (operator) => FIXTURE.find((o) => o.operator === operator),
    all: async () => FIXTURE,
    ...overrides,
  };
}

const failing = () => {
  throw Object.assign(new Error("Failed query: select ... params: secret@example.com"), { code: "08006" });
};

describe("Neon operator-ownership loaders", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("per-operator: returns the Neon row on a hit (an operator absent from the snapshot)", async () => {
    expect(await loadOperatorOwnershipUncached("Fixture Cloud", fakeSource())).toEqual([FIXTURE[0]]);
  });

  it("per-operator: falls back to the snapshot (SQLSTATE only in the warning) when Neon throws", async () => {
    const rows = await loadOperatorOwnershipUncached("QTS Data Centers", fakeSource({ one: failing }));
    expect(rows).toEqual(operatorOwnership.filter((o) => o.operator === "QTS Data Centers"));
    expect(rows).toHaveLength(1);
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).toContain("08006");
    expect(logged).not.toContain("secret@example.com");
  });

  it("per-operator: a missing Neon row means no owners, NOT the snapshot", async () => {
    expect(operatorOwnership.some((o) => o.operator === "QTS Data Centers")).toBe(true);
    expect(await loadOperatorOwnershipUncached("QTS Data Centers", fakeSource({ one: async () => undefined }))).toEqual(
      []
    );
  });

  it("per-operator: an invalid row falls back and warns, never rendering the bad data", async () => {
    const bad = { operator: "QTS Data Centers", owners: [{ name: "Bogus Owner" }] };
    const rows = await loadOperatorOwnershipUncached("QTS Data Centers", fakeSource({ one: async () => bad }));
    expect(JSON.stringify(rows)).not.toContain("Bogus Owner");
    expect(rows).toHaveLength(1);
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("invalid row");
  });

  it("per-operator: a row stored under another operator's name is rejected", async () => {
    const rows = await loadOperatorOwnershipUncached("QTS Data Centers", fakeSource({ one: async () => FIXTURE[0] }));
    expect(rows.map((o) => o.operator)).toEqual(["QTS Data Centers"]);
  });

  it("per-operator: does not touch Neon when reads may not use the database", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const one = vi.fn(async () => FIXTURE[0]);
    await loadOperatorOwnershipUncached("Fixture Cloud", fakeSource({ one }));
    expect(one).not.toHaveBeenCalled();
  });

  it("whole table: hit returns the Neon rows, not the snapshot", async () => {
    expect(await loadAllOperatorOwnershipUncached(fakeSource())).toEqual(FIXTURE);
  });

  it("whole table: throw falls back to the snapshot", async () => {
    expect(await loadAllOperatorOwnershipUncached(fakeSource({ all: failing }))).toBe(operatorOwnership);
  });

  it("whole table: an empty result falls back to the snapshot", async () => {
    expect(await loadAllOperatorOwnershipUncached(fakeSource({ all: async () => [] }))).toBe(operatorOwnership);
  });

  it("whole table: one invalid row falls back for the whole table", async () => {
    const all = async () => [...FIXTURE, { operator: "Broken", owners: [] }];
    expect(await loadAllOperatorOwnershipUncached(fakeSource({ all }))).toBe(operatorOwnership);
  });
});
