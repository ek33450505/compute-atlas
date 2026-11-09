import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSnapshotBodies, type SnapshotSource } from "@/lib/dataset-snapshot";
import { exportSnapshot } from "@/scripts/export";

// Captured from the pre-refactor scripts/export.ts exportSnapshot (fake time 2026-11-09T12:00:00Z).
const GOLDEN: Record<string, string> = {
  "facilities.json":
    "[\n  {\n    \"id\": \"alpha-mine\",\n    \"name\": \"Alpha Mining\",\n    \"operator\": \"Alpha Corp\",\n    \"status\": \"proposed\",\n    \"confidence\": \"reported\",\n    \"location\": {\n      \"lat\": 31.2,\n      \"lon\": -99.1,\n      \"state\": \"TX\",\n      \"precision\": \"approximate\"\n    },\n    \"statusHistory\": [],\n    \"sources\": [\n      {\n        \"url\": \"https://example.com/alpha\",\n        \"label\": \"Source\",\n        \"retrievedAt\": \"2026-11-01\",\n        \"kind\": \"other\"\n      }\n    ],\n    \"lastUpdated\": \"2026-10-15\",\n    \"facilityType\": \"crypto_mining\"\n  },\n  {\n    \"id\": \"mid-power\",\n    \"name\": \"Mid Plant\",\n    \"operator\": \"Mid Power\",\n    \"status\": \"under_construction\",\n    \"confidence\": \"confirmed\",\n    \"location\": {\n      \"lat\": 35,\n      \"lon\": -90,\n      \"state\": \"AR\",\n      \"precision\": \"approximate\"\n    },\n    \"statusHistory\": [],\n    \"sources\": [\n      {\n        \"url\": \"https://example.com/mid\",\n        \"label\": \"Source\",\n        \"retrievedAt\": \"2026-11-01\",\n        \"kind\": \"other\"\n      }\n    ],\n    \"lastUpdated\": \"2026-09-30\",\n    \"facilityType\": \"power_generation\",\n    \"generation\": {\n      \"technology\": \"natural_gas\"\n    }\n  },\n  {\n    \"id\": \"zeta-dc\",\n    \"name\": \"Zeta Campus\",\n    \"operator\": \"Zeta Corp\",\n    \"status\": \"operational\",\n    \"confidence\": \"confirmed\",\n    \"location\": {\n      \"lat\": 40.1,\n      \"lon\": -97.5,\n      \"city\": \"Omaha\",\n      \"state\": \"NE\",\n      \"precision\": \"approximate\"\n    },\n    \"capacityMw\": {\n      \"operational\": 120\n    },\n    \"statusHistory\": [],\n    \"sources\": [\n      {\n        \"url\": \"https://example.com/zeta\",\n        \"label\": \"Source\",\n        \"retrievedAt\": \"2026-11-01\",\n        \"kind\": \"other\"\n      }\n    ],\n    \"lastUpdated\": \"2026-11-01\",\n    \"facilityType\": \"data_center\"\n  }\n]\n",
  "facilities.meta.json":
    "{\n  \"asOf\": \"2026-11-09T12:00:00.000Z\",\n  \"recordCount\": 3,\n  \"schemaVersion\": 1\n}\n",
  "siting-context.json":
    "{\n  \"alpha-mine\": {\n    \"nearestWater\": {\n      \"name\": \"Pecos\",\n      \"kind\": \"river\",\n      \"distanceMi\": 3.2\n    }\n  },\n  \"orphan-x\": {\n    \"aquifer\": {\n      \"name\": \"Ogallala\",\n      \"rock\": \"sand\"\n    }\n  },\n  \"zeta-dc\": {\n    \"waterStress\": {\n      \"cat\": 2,\n      \"label\": \"Medium\"\n    }\n  }\n}\n",
  "operator-ownership.json":
    "[\n  {\n    \"operator\": \"Alpha Corp\",\n    \"owners\": [\n      {\n        \"name\": \"Alpha Capital\",\n        \"kind\": \"organization\",\n        \"role\": \"controlling_owner\",\n        \"source\": {\n          \"url\": \"https://example.com/own\",\n          \"label\": \"Source\",\n          \"retrievedAt\": \"2026-11-01\",\n          \"kind\": \"other\"\n        },\n        \"asOf\": \"2026-11-01\"\n      }\n    ]\n  },\n  {\n    \"operator\": \"Zeta Corp\",\n    \"owners\": [\n      {\n        \"name\": \"Zeta Holdings\",\n        \"kind\": \"organization\",\n        \"role\": \"controlling_owner\",\n        \"source\": {\n          \"url\": \"https://example.com/own\",\n          \"label\": \"Source\",\n          \"retrievedAt\": \"2026-11-01\",\n          \"kind\": \"other\"\n        },\n        \"asOf\": \"2026-11-01\"\n      }\n    ]\n  }\n]\n",
};

const src = (url: string) => ({ url, label: "Source", retrievedAt: "2026-11-01" });

// Deliberately fed out of id order so the sort is observable.
const FACILITIES = [
  {
    id: "zeta-dc",
    name: "Zeta Campus",
    operator: "Zeta Corp",
    facilityType: "data_center",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 40.1, lon: -97.5, state: "NE", city: "Omaha" },
    capacityMw: { operational: 120 },
    sources: [src("https://example.com/zeta")],
    lastUpdated: "2026-11-01",
  },
  {
    id: "alpha-mine",
    name: "Alpha Mining",
    operator: "Alpha Corp",
    facilityType: "crypto_mining",
    status: "proposed",
    confidence: "reported",
    location: { lat: 31.2, lon: -99.1, state: "TX" },
    sources: [src("https://example.com/alpha")],
    lastUpdated: "2026-10-15",
  },
  {
    id: "mid-power",
    name: "Mid Plant",
    operator: "Mid Power",
    facilityType: "power_generation",
    status: "under_construction",
    confidence: "confirmed",
    location: { lat: 35, lon: -90, state: "AR" },
    generation: { technology: "natural_gas" },
    sources: [src("https://example.com/mid")],
    lastUpdated: "2026-09-30",
  },
];

// Out of order, one null field, and one orphan (no matching facility); mid-power has no row.
const SITING = [
  { facilityId: "zeta-dc", data: { waterStress: { cat: 2, label: "Medium" } } },
  { facilityId: "orphan-x", data: { aquifer: { name: "Ogallala", rock: "sand" } } },
  {
    facilityId: "alpha-mine",
    data: { nearestWater: { name: "Pecos", kind: "river", distanceMi: 3.2 }, aquifer: null },
  },
];

const owner = (name: string) => ({
  name,
  kind: "organization",
  role: "controlling_owner",
  source: src("https://example.com/own"),
  asOf: "2026-11-01",
});
const OWNERSHIP = [
  { operator: "Zeta Corp", owners: [owner("Zeta Holdings")] },
  { operator: "Alpha Corp", owners: [owner("Alpha Capital")] },
];

const small = { facilities: 1, siting: 1, ownership: 1 };
const source: SnapshotSource = {
  facilities: async () => FACILITIES.map((doc) => ({ doc })) as never,
  sitingContext: async () => SITING,
  operatorOwnership: async () => OWNERSHIP.map((data) => ({ data })),
};

describe("exportSnapshot golden (captured from the pre-refactor code)", () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
    dir = mkdtempSync(path.join(os.tmpdir(), "dataset-snapshot-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes files byte-identical to the captured output", async () => {
    const warn = vi.fn();
    await exportSnapshot({ dir, source, floors: small, warn });
    const written = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(path.join(dir, f), "utf-8")]));
    expect(written).toEqual(GOLDEN);
  });

  it("stamps asOf BEFORE the reads, not after (db:sync's stale-basis guard relies on it)", async () => {
    const later = new Date("2026-11-09T12:30:00.000Z");
    const advancing: SnapshotSource = {
      ...source,
      facilities: async () => {
        vi.setSystemTime(later);
        return source.facilities();
      },
    };
    await exportSnapshot({ dir, source: advancing, floors: small, warn: vi.fn() });
    expect(new Date().toISOString()).toBe(later.toISOString());
    const meta = JSON.parse(readFileSync(path.join(dir, "facilities.meta.json"), "utf-8"));
    expect(meta.asOf).toBe("2026-11-09T12:00:00.000Z");
  });
});

describe("buildSnapshotBodies", () => {
  const readAt = new Date("2026-11-09T12:00:00.000Z");

  it("returns the four bodies byte-identical to the golden capture, in write order", async () => {
    const { bodies } = await buildSnapshotBodies(source, { floors: small, readAt, warn: vi.fn() });
    expect(bodies.map(([name]) => name)).toEqual([
      "facilities.json",
      "facilities.meta.json",
      "siting-context.json",
      "operator-ownership.json",
    ]);
    expect(Object.fromEntries(bodies)).toEqual(GOLDEN);
  });

  it("stamps the caller's readAt into the meta body, not the current time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      const { bodies } = await buildSnapshotBodies(source, { floors: small, readAt, warn: vi.fn() });
      expect(JSON.parse(Object.fromEntries(bodies)["facilities.meta.json"]).asOf).toBe("2026-11-09T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports and warns about a missing and an orphan siting row", async () => {
    const warn = vi.fn();
    const built = await buildSnapshotBodies(source, { floors: small, readAt, warn });
    expect(built.missingSiting).toBe(1);
    expect(built.orphanSiting).toBe(1);
    expect(built.facilities.map((f) => f.id)).toEqual(["alpha-mine", "mid-power", "zeta-dc"]);
    expect(Object.keys(built.siting)).toEqual(["alpha-mine", "orphan-x", "zeta-dc"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 facilities have no siting_context row"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 siting_context rows have no matching facility"));
  });

  it("refuses a read below any floor", async () => {
    const run = (floors: { facilities: number; siting: number; ownership: number }) =>
      buildSnapshotBodies(source, { floors, readAt, warn: vi.fn() });
    await expect(run({ facilities: 4, siting: 1, ownership: 1 })).rejects.toThrow(/3 facilities is below the floor of 4/);
    await expect(run({ facilities: 1, siting: 4, ownership: 1 })).rejects.toThrow(/3 siting_context rows is below the floor of 4/);
    await expect(run({ facilities: 1, siting: 1, ownership: 3 })).rejects.toThrow(/2 operator_ownership rows is below the floor of 3/);
  });
});
