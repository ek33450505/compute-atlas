// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { facilitiesToCsv } from "../lib/dataset-csv";
import { watermarkCsv, watermarkJsonArray } from "../lib/dataset-watermark";
import { facilitySchema, type Facility } from "../lib/schema";
import {
  formatTable,
  loadTraceInputs,
  parseArgs,
  parseLeakedText,
  scoreGrants,
  splitKnownIds,
  TraceError,
} from "./dataset-trace";

const SECRET = "trace-test-secret-0123456789abcdef-xyz";
const EDITION_ID = "22222222-2222-4222-8222-222222222222";
const N = 200;

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const grants = Array.from({ length: 20 }, (_, i) => ({ id: uuid(i + 1), organization: `Org ${i + 1}` }));
const GRANT_A = grants[7];
const key = { secret: SECRET, editionId: EDITION_ID };

const make = (id: string, over: Record<string, unknown> = {}): Facility =>
  facilitySchema.parse({
    confidence: "confirmed",
    sources: [{ url: `https://example.com/${id}`, label: "A", retrievedAt: "2026-11-01" }],
    lastUpdated: "2026-11-01",
    id,
    name: `Site ${id}`,
    operator: "Op",
    status: "operational",
    location: { lat: 40, lon: -97.5, state: "NE" },
    facilityType: "data_center",
    ...over,
  });

/** Base order = sorted by id. Every 17th name forces a quoted multi-line CSV cell. */
const facilities: Facility[] = Array.from({ length: N }, (_, i) =>
  make(`site-${String(i).padStart(4, "0")}`, i % 17 === 0 ? { name: `Campus, "N"\r\nWing ${i}` } : {})
);
const baseIds = facilities.map((f) => f.id);

const baseJson = JSON.stringify(facilities, null, 2) + "\n";
const baseCsv = facilitiesToCsv(facilities);
const keyFor = (grantId: string) => ({ ...key, grantId });

const servedJson = (grantId: string) => parseLeakedText(watermarkJsonArray(baseJson, keyFor(grantId)));
const servedCsv = (grantId: string) => parseLeakedText(watermarkCsv(baseCsv, keyFor(grantId)));

/** Deterministic PRNG so the random-subset test is reproducible. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rank = (leaked: string[]) => scoreGrants(leaked, baseIds, grants, key);
const positionOf = (ranked: ReturnType<typeof rank>, grantId: string) => ranked.findIndex((r) => r.grantId === grantId);

describe("scoreGrants", () => {
  it("ranks the grant a JSON file was served to first, with a clear margin", () => {
    const ranked = rank(servedJson(GRANT_A.id));
    expect(ranked[0].grantId).toBe(GRANT_A.id);
    expect(ranked[0].score).toBeCloseTo(1, 10);
    expect(ranked[0].positionMatch).toBe(1);
    expect(ranked[0].adjacentPairs).toBe(1);
    expect(ranked[1].score).toBeLessThan(0.1);
    expect(ranked[0].organization).toBe("Org 8");
  });

  it("gives the same ranking from the CSV as from the JSON", () => {
    const fromJson = rank(servedJson(GRANT_A.id));
    const fromCsv = rank(servedCsv(GRANT_A.id));
    expect(servedCsv(GRANT_A.id)).toEqual(servedJson(GRANT_A.id));
    expect(fromCsv).toEqual(fromJson);
    expect(fromCsv[0].grantId).toBe(GRANT_A.id);
  });

  it("still ranks the grant first for a 30% contiguous slice", () => {
    const served = servedJson(GRANT_A.id);
    const slice = served.slice(50, 50 + Math.round(N * 0.3));
    const ranked = rank(slice);
    expect(ranked[0].grantId).toBe(GRANT_A.id);
    expect(ranked[0].adjacentPairs).toBe(1);
    expect(ranked[0].score).toBeGreaterThan(0.7);
    expect(ranked[1].score).toBeLessThan(0.1);
    // Position is useless on a slice; this is what adjacency is for.
    expect(ranked[0].positionMatch).toBeLessThan(0.1);
  });

  it("keeps the grant in the top 3 for a random 30% subset (adjacency weakens to ~0.3; documented limit)", () => {
    // Keeping each row with p=0.3 leaves ~30% of leaked neighbours adjacent in the true order against ~1/n by chance.
    // Measured over 200 seeds on this 200-row, 20-grant fixture: the true grant ranks first 200/200 at 50%, 30% and 20%
    // keep rates, and only 152/200 at 10% (20 rows; worst rank 13th). The test holds the claim to top 3 at 30%.
    for (const seed of [1, 2, 3, 4, 5]) {
      const rand = mulberry32(seed);
      const subset = servedJson(GRANT_A.id).filter(() => rand() < 0.3);
      const ranked = rank(subset);
      expect(positionOf(ranked, GRANT_A.id)).toBeLessThan(3);
      expect(ranked[positionOf(ranked, GRANT_A.id)].adjacentPairs).toBeGreaterThan(0.15);
    }
  });

  it("scores a file re-sorted by id low for every grant (documented limit: order is the whole watermark)", () => {
    const ranked = rank([...baseIds]);
    for (const r of ranked) {
      expect(r.score).toBeLessThan(0.1);
    }
  });

  it("ignores ids that are not in the edition, and counts them", () => {
    const served = servedJson(GRANT_A.id);
    const polluted = ["ghost-1", ...served.slice(0, 100), "ghost-2", ...served.slice(100)];
    expect(splitKnownIds(polluted, baseIds)).toEqual({ known: served, unknown: 2 });
    const ranked = rank(polluted);
    expect(ranked[0].grantId).toBe(GRANT_A.id);
    expect(ranked[0].score).toBeCloseTo(1, 10);
  });

  it("scores zero, without throwing, for an empty or single-row leak", () => {
    expect(rank([]).every((r) => r.score === 0)).toBe(true);
    expect(rank([baseIds[0]]).every((r) => r.adjacentPairs === 0)).toBe(true);
  });

  it("returns rows sorted by score, descending", () => {
    const scores = rank(servedJson(GRANT_A.id)).map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("parseLeakedText", () => {
  it("reads ids in file order from a JSON array", () => {
    expect(parseLeakedText('[{"id":"b","x":1},{"id":"a"}]')).toEqual(["b", "a"]);
  });

  it("rejects a JSON element without a string id", () => {
    expect(() => parseLeakedText('[{"id":"a"},{"name":"x"}]')).toThrow(TraceError);
    expect(() => parseLeakedText("[1]")).toThrow(TraceError);
  });

  it("reads the first column of an RFC 4180 CSV, through quoted commas, quotes and line breaks", () => {
    const csv = 'id,name\r\na-1,"x, ""y""\r\nz"\r\nb-2,plain\r\n';
    expect(parseLeakedText(csv)).toEqual(["a-1", "b-2"]);
  });

  it("tolerates LF record ends and a BOM (a spreadsheet re-save)", () => {
    expect(parseLeakedText("﻿id,name\na-1,x\nb-2,y\n")).toEqual(["a-1", "b-2"]);
  });

  it("refuses a CSV whose first column is not id, or with an unterminated quote", () => {
    expect(() => parseLeakedText("name,id\r\nx,a\r\n")).toThrow(/id column/);
    expect(() => parseLeakedText('id,name\r\na,"oops\r\n')).toThrow(/unterminated/);
  });
});

describe("parseArgs", () => {
  it("takes a file and --edition in either form", () => {
    expect(parseArgs(["f.json", "--edition", "2026-11-09"])).toEqual({ file: "f.json", edition: "2026-11-09" });
    expect(parseArgs(["--edition=2026-11-09", "f.csv"])).toEqual({ file: "f.csv", edition: "2026-11-09" });
  });

  it("refuses a missing file, a missing edition and unknown options", () => {
    expect(() => parseArgs(["f.json"])).toThrow(/usage/);
    expect(() => parseArgs(["--edition", "2026-11-09"])).toThrow(/usage/);
    expect(() => parseArgs(["f.json", "--edition", "x", "--apply"])).toThrow(/unknown option/);
  });
});

describe("formatTable", () => {
  it("prints grant id, organization and scores, never an email field", () => {
    const out = formatTable(rank(servedJson(GRANT_A.id)).slice(0, 2));
    expect(out).toContain(GRANT_A.id);
    expect(out).toContain("Org 8");
    expect(out.split("\n")[0]).toBe(["grantId", "organization", "score", "positionMatch", "adjacentPairs"].join("\t"));
  });
});

/**
 * A db handle whose select chain resolves to canned rows and whose every write method fails the
 * test. `loadTraceInputs` is typed `Pick<db, "select">`, so this also pins the runtime behaviour
 * the type promises.
 */
function fakeDb(editionRows: unknown[], grantRows: unknown[]) {
  const writes = { insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const selectedFields: unknown[] = [];
  let call = 0;
  const select = vi.fn((fields: unknown) => {
    selectedFields.push(fields);
    const rows = call++ === 0 ? editionRows : grantRows;
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => Promise.resolve(rows);
    chain.limit = () => Promise.resolve(rows);
    return chain;
  });
  return { db: { select, ...writes } as never, select, writes, selectedFields };
}

const editionRow = {
  id: EDITION_ID,
  editionDate: "2026-11-09",
  status: "published",
  files: [{ name: "facilities.json", pathname: "editions/2026-11-09/facilities.json", bytes: 1, sha256: "x" }],
};

describe("loadTraceInputs", () => {
  it("only selects: insert, update and delete are never called", async () => {
    const { db, select, writes } = fakeDb([editionRow], [{ id: GRANT_A.id, organization: "Org 8" }]);
    const read = vi.fn().mockResolvedValue(baseJson);
    const out = await loadTraceInputs(db, "2026-11-09", read);
    expect(select).toHaveBeenCalledTimes(2);
    expect(writes.insert).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(writes.delete).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith("editions/2026-11-09/facilities.json");
    expect(out.baseIds).toEqual(baseIds);
    expect(out.edition).toEqual({ id: EDITION_ID, editionDate: "2026-11-09" });
    expect(out.grants).toEqual([{ id: GRANT_A.id, organization: "Org 8" }]);
  });

  it("selects grant id and organization only, never an email", async () => {
    const { db, selectedFields } = fakeDb([editionRow], []);
    await loadTraceInputs(db, EDITION_ID, async () => baseJson);
    expect(Object.keys(selectedFields[1] as object).sort()).toEqual(["id", "organization"]);
  });

  it("refuses a malformed edition ref, an unknown edition and an unpublished one", async () => {
    await expect(loadTraceInputs(fakeDb([], []).db, "latest", async () => baseJson)).rejects.toThrow(/YYYY-MM-DD/);
    await expect(loadTraceInputs(fakeDb([], []).db, "2026-11-09", async () => baseJson)).rejects.toThrow(/no edition/);
    await expect(
      loadTraceInputs(fakeDb([{ ...editionRow, status: "failed" }], []).db, "2026-11-09", async () => baseJson)
    ).rejects.toThrow(/not published/);
  });

  it("refuses an edition whose facilities.json is not on record or not in storage", async () => {
    await expect(
      loadTraceInputs(fakeDb([{ ...editionRow, files: [] }], []).db, "2026-11-09", async () => baseJson)
    ).rejects.toThrow(/no facilities.json/);
    await expect(loadTraceInputs(fakeDb([editionRow], []).db, "2026-11-09", async () => null)).rejects.toThrow(/missing from storage/);
  });
});
