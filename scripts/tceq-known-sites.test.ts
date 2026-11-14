import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isEditorialOnlyChange } from "../lib/editorial-change";
import { facilitySchema, v2SourceIndexRefs, type Facility } from "../lib/schema";
import { TceqRequestError, type TceqRow, type TceqSummary } from "./discovery/tceq-client";
import { looksLikeAddress } from "./discovery/tceq-names";
import {
  RunAborted,
  UsageError,
  assertSafeOut,
  WITHHELD,
  acresProblem,
  applyApproved,
  applyApprovedFile,
  beyondHorizon,
  buildProposedPatch,
  buildReviewList,
  classify,
  dateProblem,
  guarded,
  main,
  requestBudget,
  run,
  segmentProblem,
  waterNameProblem,
  haversineKm,
  normalizeOrg,
  operatorMatches,
  parseArgs,
  retryOnce,
  prefilterRow,
  rankCandidates,
  renderMarkdown,
  searchWindowed,
  selectCohort,
  titleCase,
  todayIso,
  tokenOverlap,
} from "./tceq-known-sites";

const urlFor = (permit: string, extra = "") =>
  `https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary&lgl_ident_txt=${permit}${extra}`;
const URL_A = urlFor("TXR15AAAA");
const URL_B = urlFor("TXR15BBBB");
const TODAY = "2026-11-13";

/** A fake live TCEQ: the summary of whichever permit the URL names. */
const liveSummaries = (over: Record<string, Partial<TceqSummary>> = {}) =>
  vi.fn(async (url: string) => {
    const id = new URL(url).searchParams.get("lgl_ident_txt") ?? "";
    return summary({ permitNumber: id, ...over[id] });
  });

function facility(over: Record<string, unknown> = {}): Facility {
  return facilitySchema.parse({
    id: "example-campus-bastrop-tx",
    name: "Project Example Data Center Campus",
    operator: "Example Partners (Example Group affiliate)",
    status: "proposed",
    confidence: "reported",
    location: { lat: 30.0754, lon: -97.4262, city: "Cedar Creek", county: "Bastrop County", state: "TX", precision: "approximate" },
    statusHistory: [{ status: "proposed", date: "2026-10-09", sourceIndex: 0 }],
    sources: [{ url: "https://example.com/a", label: "A", retrievedAt: "2026-11-04", kind: "press" }],
    lastUpdated: "2026-11-04",
    facilityType: "data_center",
    ...over,
  });
}

function row(over: Partial<TceqRow> = {}): TceqRow {
  return { permitNumber: "TXR15AAAA", summaryUrl: URL_A, siteName: "EXAMPLE CEDAR CREEK CAMPUS", permittee: "Example Partners, LLC", ...over };
}

function summary(over: Partial<TceqSummary> = {}): TceqSummary {
  return {
    permitNumber: "TXR15AAAA",
    areaDisturbedAcres: 304,
    receivingWater: "BRUSHY CREEK",
    segment: "1244",
    coverageBegan: "2026-07-14",
    estimatedStart: "2026-09-01",
    estimatedEnd: "2028-10-01",
    lat: 30.057081,
    lon: -97.428818,
    ...over,
  };
}

describe("normalizeOrg / operatorMatches", () => {
  it("drops parentheticals, punctuation and trailing suffixes only", () => {
    expect(normalizeOrg("Example Partners (Example Group affiliate)")).toBe("example partners");
    expect(normalizeOrg("Example Partners, L.L.C.")).toBe("example partners");
    expect(normalizeOrg("Smith & Sons Co., Inc.")).toBe("smith and sons");
    expect(normalizeOrg("Inc Holdings LLC")).toBe("inc holdings");
  });
  it("matches the parenthetical case exactly", () => {
    expect(operatorMatches("Example Partners, LLC", ["Example Partners (Example Group affiliate)"])).toBe(true);
  });
  it("never matches by prefix or substring", () => {
    expect(operatorMatches("Jane Q Example", ["Jane Partners"])).toBe(false);
    expect(operatorMatches("Jane Partners", ["Jane Q Example"])).toBe(false);
    expect(operatorMatches("Example Partners Holdings", ["Example Partners"])).toBe(false);
  });
  it("ignores keys under 4 chars", () => {
    expect(operatorMatches("ABC LLC", ["ABC Inc"])).toBe(false);
  });
});

describe("token prefilter and rules", () => {
  it("overlaps on distinctive tokens only", () => {
    expect(tokenOverlap("EXAMPLE CEDAR CREEK CAMPUS", ["Project Example Data Center Campus", "Cedar Creek"])).toEqual(["cedar", "example"]);
    expect(tokenOverlap("DATA CENTER CAMPUS PHASE", ["Project Data Center Campus"])).toEqual([]);
  });
  it("does not keep the transmission-line noise matched only on the city", () => {
    const f = facility();
    const noise = row({ permittee: "Utility Co", siteName: "CEDAR HILL TO SWIFTEX T367 TRANSMISSION LINE OVERHAUL" });
    expect(prefilterRow(noise, f).rules).toEqual([]);
    expect(prefilterRow({ ...noise, sic: "1623" }, f).rules).toEqual([]);
  });
  it("strips place tokens (city, county) from the facility name before matching", () => {
    const f = facility({
      id: "hyper-lufkin-angelina-county-tx",
      name: "Hyper Lufkin Data Center",
      location: { lat: 31.3, lon: -94.7, city: "Lufkin", county: "Angelina County", state: "TX", precision: "approximate" },
    });
    const lufkin = row({ permittee: "City Of Lufkin", siteName: "CITY OF LUFKIN - ORCHARD VIEW PARK BUILDING C" });
    expect(prefilterRow(lufkin, f).rules).toEqual([]);
    expect(prefilterRow(row({ permittee: "X Co", siteName: "ANGELINA COUNTY ARENA" }), f).rules).toEqual([]);
    expect(prefilterRow(row({ permittee: "X Co", siteName: "HYPER LUFKIN 2" }), f).rules).toEqual(["token"]);
  });
  it("keeps a brand token", () => {
    const f = facility({ name: "Vantage Frontier Campus", location: { lat: 33, lon: -97, city: "Plano", county: "Collin County", state: "TX", precision: "exact" } });
    expect(prefilterRow(row({ permittee: "Y Co", siteName: "VANTAGE DC TX22" }), f).rules).toEqual(["token"]);
  });
  it("reports operator, token and keyword rules", () => {
    const f = facility();
    expect(prefilterRow(row(), f).rules).toEqual(["operator", "token"]);
    expect(prefilterRow(row({ permittee: "Someone Else LP", siteName: "ACME BITCOIN FARM" }), f).rules).toEqual(["keyword"]);
    expect(prefilterRow(row({ permittee: "Someone Else LP", siteName: "SOUTH FIELD" }), f).rules).toEqual([]);
  });
});

describe("distance, classification, ranking", () => {
  it("computes great-circle km", () => {
    expect(haversineKm(30, -97, 30, -97)).toBe(0);
    expect(haversineKm(0, 0, 0, 1)).toBeCloseTo(111.195, 2);
    expect(haversineKm(30.0754, -97.4262, 30.057081, -97.428818)).toBeCloseTo(2.05, 2);
  });
  it("classifies: operator within 10 km; site rules within 5 km; else possible", () => {
    expect(classify(["operator"], 9.9)).toBe("strong");
    expect(classify(["operator"], 12)).toBe("possible");
    expect(classify(["token"], 0.21)).toBe("strong");
    expect(classify(["token"], 4.9)).toBe("strong");
    expect(classify(["token"], 7)).toBe("possible");
    expect(classify(["keyword"], 5.1)).toBe("possible");
    expect(classify(["keyword"], 4)).toBe("strong");
    expect(classify(["operator"], null)).toBe("possible");
  });
  it("ranks strong, then operator, then nearest", () => {
    const c = [
      { id: "p", strength: "possible" as const, rules: ["operator" as const], distanceKm: 1 },
      { id: "s2", strength: "strong" as const, rules: ["token" as const], distanceKm: 1 },
      { id: "s1", strength: "strong" as const, rules: ["operator" as const], distanceKm: 8 },
      { id: "s3", strength: "strong" as const, rules: ["token" as const], distanceKm: 0.5 },
    ];
    expect(rankCandidates(c).map((x) => x.id)).toEqual(["s1", "s3", "s2", "p"]);
  });
});

describe("searchWindowed", () => {
  it("splits on 'narrow the search' and retries, then skips a one-month window", async () => {
    const calls: string[] = [];
    const search = vi.fn(async (c: { startDate?: string; endDate?: string }) => {
      calls.push(`${c.startDate}..${c.endDate}`);
      if (c.startDate === "2024-01-01" && c.endDate === "2024-12-31") throw new Error("... narrow the search");
      return { rows: [row({ permitNumber: `P${calls.length}` })] };
    });
    const r = await searchWindowed(search, "BASTROP", "2024-01-01", "2024-12-31");
    expect(r.skipped).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(calls[0]).toBe("2024-01-01..2024-12-31");
    expect(calls[1].startsWith("2024-01-01..")).toBe(true);
    expect(calls[2].endsWith("..2024-12-31")).toBe(true);

    const always = vi.fn(async () => {
      throw new Error("narrow the search");
    });
    const s = await searchWindowed(always, "BASTROP", "2024-01-01", "2024-01-20");
    expect(s.rows).toEqual([]);
    expect(s.skipped).toEqual(["BASTROP 2024-01-01..2024-01-20"]);
  });
  it("rethrows other errors", async () => {
    await expect(searchWindowed(async () => { throw new Error("boom"); }, "X", "2024-01-01", "2024-06-01")).rejects.toThrow("boom");
  });
});

describe("selectCohort and parseArgs", () => {
  it("filters on state, type, status and filled", () => {
    const filled = facility({ id: "filled-tx", construction: { disturbedAcres: { value: 5, sourceIndex: 0 } } });
    const ok = facility();
    const ca = facility({ id: "ca", location: { lat: 1, lon: 1, state: "CA", precision: "exact" } });
    const live = facility({ id: "live", status: "operational" });
    const opts = { statuses: ["proposed", "permitted"], includeFilled: false };
    expect(selectCohort([ok, filled, ca, live], opts).map((f) => f.id)).toEqual(["example-campus-bastrop-tx"]);
    expect(selectCohort([ok, filled], { ...opts, includeFilled: true })).toHaveLength(2);
  });
  it("enforces the --since floor", () => {
    expect(() => parseArgs(["--since=2019-12-31"])).toThrow(/2020-01-01/);
    expect(parseArgs(["--since=2020-01-01"]).since).toBe("2020-01-01");
  });
  it("parses flags", () => {
    expect(parseArgs(["--since=2025-01-01", "--statuses", "proposed", "--include-filled", "--max-summaries=3", "--out=x.json"])).toMatchObject({
      since: "2025-01-01", statuses: ["proposed"], includeFilled: true, maxSummaries: 3, out: "x.json",
    });
    expect(() => parseArgs(["--bogus"])).toThrow(UsageError);
    expect(() => parseArgs(["--statuses=proposed,planned_maybe"])).toThrow(/unknown status/);
    expect(() => parseArgs(["--statuses=proposed,under_construction"])).not.toThrow();
    expect(() => parseArgs(["--since=nope"])).toThrow();
  });
});

describe("buildReviewList and the names rule", () => {
  const deps = (rows: TceqRow[], over: Record<string, Partial<TceqSummary>> = {}) => ({
    search: vi.fn(async () => ({ rows })),
    fetchSummary: liveSummaries(over),
    today: TODAY,
    log: vi.fn(),
  });
  const opts = { since: "2024-01-01", statuses: ["proposed"], includeFilled: false, maxSummaries: 10, maxSummariesPerFacility: 4 };

  it("shows names only under the structural rule", async () => {
    const individual = row({ permitNumber: "TXR15BBBB", summaryUrl: URL_B, permittee: "Jane Q Person", siteName: "CRYPTO MINING PAD" });
    const d = deps([row(), individual]);
    const r = await buildReviewList([facility()], opts, d);
    const cands = r.facilities[0].candidates;
    const a = cands.find((c) => c.permitNumber === "TXR15AAAA")!;
    const b = cands.find((c) => c.permitNumber === "TXR15BBBB")!;
    expect(a.permittee).toBe("Example Partners, LLC");
    expect(a.siteName).toBe("EXAMPLE CEDAR CREEK CAMPUS");
    expect(a.strength).toBe("strong");
    expect(a.approved).toBe(false);
    expect(b.permittee).toBe(WITHHELD);
    expect(b.siteName).toBe("CRYPTO MINING PAD");
    expect(r.facilities[0].facilityName).toBe("Project Example Data Center Campus");
    expect(JSON.stringify(r)).not.toContain("Jane");
    expect(renderMarkdown(r)).not.toContain("Jane");
    expect(r.stats).toMatchObject({ cohort: 1, countiesSearched: 1, rows: 2, kept: 2, summariesFetched: 2, facilitiesStrong: 1 });
    expect(d.search).toHaveBeenCalledWith({ permitStatus: "ACTIVE", county: "BASTROP", startDate: "2024-01-01", endDate: TODAY });
  });

  it("withholds a token-only site name and records the matched tokens instead", async () => {
    const tokenOnly = row({ permittee: "Nobody Co", siteName: "EXAMPLE SOMETHING ELSE" });
    const r = await buildReviewList([facility()], opts, deps([tokenOnly]));
    const c = r.facilities[0].candidates[0];
    expect(c.rules).toEqual(["token"]);
    expect(c.siteName).toBe(WITHHELD);
    expect(c.matchedTokens).toEqual(["example"]);
    expect(JSON.stringify(r)).not.toContain("SOMETHING");
    expect(renderMarkdown(r)).toContain("matched tokens: example");
  });

  it("always withholds a residential or address-shaped site name, even on an operator match", async () => {
    for (const siteName of ["5911 BLACKPINE CIRCLE", "HACIENDA EXAMPLE DBA PATRIOT HOMES", "EXAMPLE DATA CENTER LOT 4"]) {
      const r = await buildReviewList([facility()], opts, deps([row({ siteName })]));
      expect(r.facilities[0].candidates[0].siteName).toBe(WITHHELD);
      expect(JSON.stringify(r)).not.toContain(siteName);
    }
    expect(looksLikeAddress("5911 BLACKPINE CIRCLE")).toBe(true);
    expect(looksLikeAddress("HACIENDA EXAMPLE DBA PATRIOT HOMES")).toBe(true);
    expect(looksLikeAddress("BCG CEDAR CREEK CAMPUS")).toBe(false);
  });

  it("shows the normalized site name (NFKC, collapsed whitespace)", async () => {
    const r = await buildReviewList([facility()], opts, deps([row({ siteName: "  BCG   ＤＡＴＡ CENTER " })]));
    expect(r.facilities[0].candidates[0].siteName).toBe("BCG DATA CENTER");
  });

  it("drops rows that pass no rule, so their names never appear", async () => {
    const other = row({ permitNumber: "TXR15BBBB", summaryUrl: URL_B, permittee: "Jane Q Person", siteName: "SMITH RESIDENCE" });
    const r = await buildReviewList([facility()], opts, deps([other]));
    expect(r.facilities).toEqual([]);
  });

  it("proposes validated values only and never echoes a rejected raw value", async () => {
    const r = await buildReviewList([facility()], opts, deps([row()], { TXR15AAAA: { receivingWater: "19560", segment: "ZZ" } }));
    const c = r.facilities[0].candidates[0];
    expect(c.patch.receivingWater).toBeUndefined();
    expect(c.notProposed).toEqual(["receivingWater: has a 5+ digit run"]);
    expect(JSON.stringify(r)).not.toContain("19560");
    expect(renderMarkdown(r)).toContain("not proposed: receivingWater");
  });

  it("flags a passed estimated start and does not propose it (injected clock)", async () => {
    const r = await buildReviewList([facility()], opts, deps([row()]));
    const c = r.facilities[0].candidates[0];
    expect(c.patch).toEqual({
      disturbedAcres: 304,
      receivingWater: { name: "Brushy Creek", segment: "1244" },
      expectedCompletion: "2028-10-01",
    });
    expect(c.flags).toEqual(["permit's estimated start (2026-09-01) has passed; check the record's status"]);
    const earlier = await buildReviewList([facility()], opts, { ...deps([row()]), today: "2026-08-01" });
    expect(earlier.facilities[0].candidates[0].patch.expectedStart).toBe("2026-09-01");
    expect(earlier.facilities[0].candidates[0].flags).toEqual([]);
  });

  it("flags a permit that is a candidate for several facilities", async () => {
    const b = facility({ id: "second-tx", name: "Another Example Site", operator: "Elsewhere Holdings" });
    const r = await buildReviewList([facility(), b], opts, deps([row({ permittee: "Nobody Co", siteName: "EXAMPLE PAD" })]));
    expect(r.facilities).toHaveLength(2);
    for (const f of r.facilities) expect(f.candidates[0].flags).toContain("permit is a candidate for 2 facilities; approve at most one");
    const solo = await buildReviewList([facility()], opts, deps([row()]));
    expect(solo.facilities[0].candidates[0].flags.some((x) => x.includes("candidate for"))).toBe(false);
  });

  it("fetches by priority within a per-facility budget and reuses fetched rows", async () => {
    const rows = [
      row({ permitNumber: "TXR15T001", summaryUrl: urlFor("TXR15T001"), permittee: "Nobody Co", siteName: "EXAMPLE PAD" }),
      row({ permitNumber: "TXR15K001", summaryUrl: urlFor("TXR15K001"), permittee: "Nobody Co", siteName: "ACME CRYPTO SITE" }),
      row({ permitNumber: "TXR15O001", summaryUrl: urlFor("TXR15O001"), permittee: "Example Partners LLC", siteName: "MISC" }),
    ];
    const d = deps(rows);
    const second = facility({ id: "second-tx", name: "Another Example Site", operator: "Elsewhere Holdings" });
    const r = await buildReviewList([facility(), second], { ...opts, maxSummariesPerFacility: 2 }, d);
    expect(d.fetchSummary.mock.calls.map((c) => new URL(c[0]).searchParams.get("lgl_ident_txt"))).toEqual(["TXR15O001", "TXR15K001", "TXR15T001"]);
    expect(r.facilities[0].candidates).toHaveLength(2);
    expect(r.stats.budgetTruncated).toBe(1);
    expect(r.stats.summariesFetched).toBe(3);
    expect(r.facilities[1].candidates.map((c) => c.permitNumber).sort()).toEqual(["TXR15K001", "TXR15T001"]);
  });

  it("still uses rows fetched for another facility after this facility's budget is spent", async () => {
    const rows = [
      row({ permitNumber: "TXR15T001", summaryUrl: urlFor("TXR15T001"), permittee: "Nobody Co", siteName: "ALPHA PAD" }),
      row({ permitNumber: "TXR15Z001", summaryUrl: urlFor("TXR15Z001"), permittee: "Zed Holdings LLC", siteName: "MISC ONE" }),
      row({ permitNumber: "TXR15Z002", summaryUrl: urlFor("TXR15Z002"), permittee: "Zed Holdings LLC", siteName: "MISC TWO" }),
    ];
    const a = facility({ id: "a-tx", name: "Alpha Campus", operator: "Nobody Corp" });
    const b = facility({ id: "b-tx", name: "Alpha Beta Site", operator: "Zed Holdings" });
    const r = await buildReviewList([a, b], { ...opts, maxSummariesPerFacility: 1 }, deps(rows));
    const forB = r.facilities.find((f) => f.id === "b-tx")!;
    expect(forB.candidates.map((c) => c.permitNumber).sort()).toEqual(["TXR15T001", "TXR15Z001"]);
  });

  it("lists facilities short of budget when the global cap is hit", async () => {
    const r = await buildReviewList([facility()], { ...opts, maxSummaries: 0 }, deps([row()]));
    expect(r.stats.shortOfBudget).toEqual(["example-campus-bastrop-tx"]);
    expect(r.stats.summaryCapHit).toBe(true);
  });

  it("treats a summary for a different permit as a summary error, not a candidate", async () => {
    const d = { ...deps([row()]), fetchSummary: vi.fn(async () => summary({ permitNumber: "TXR15ZZZZ" })) };
    const r = await buildReviewList([facility()], opts, d);
    expect(r.facilities).toEqual([]);
    expect(r.stats.summaryErrors).toBe(1);
    expect(JSON.stringify(r)).not.toContain("ZZZZ");
  });

  it("aborts the run rather than counting a RunAborted as a summary error", async () => {
    const d = { ...deps([row()]), fetchSummary: vi.fn(async () => { throw new RunAborted("stop"); }) };
    await expect(buildReviewList([facility()], opts, d)).rejects.toBeInstanceOf(RunAborted);
  });
});

describe("validators", () => {
  it("accepts a real water body name", () => {
    expect(waterNameProblem("BRUSHY CREEK")).toBeNull();
    expect(waterNameProblem("  Upper   Pecos River ")).toBeNull();
  });
  it("rejects the real-world garbage shapes", () => {
    expect(waterNameProblem("PROPOSED ON-SITE DETENTION PONDS TO BE CONSTRUCTED. THERE ARE CURRENTLY NO EXI")).not.toBeNull();
    expect(waterNameProblem("19560")).not.toBeNull();
    expect(waterNameProblem("DISCHARGES TO NORTH GROESBECK CREEK SEGMENT 0206C")).not.toBeNull();
    expect(waterNameProblem("PLAYA LAKE TX19858")).not.toBeNull();
    expect(waterNameProblem("DRAINAGE SWALE")).toBe("names no water body");
    for (const generic of ["Ditch", "Unnamed Tributary", "Storm Drain", "Local Drainage Ditch", "Tributary"]) {
      expect(waterNameProblem(generic)).not.toBeNull();
    }
    expect(waterNameProblem("Clear Fork Plum Creek")).toBeNull();
    expect(waterNameProblem("Brazos River/Lake Brazos")).toBeNull();
    expect(waterNameProblem("A B C D E F G CREEK")).toBe("more than 6 words");
    expect(waterNameProblem("CREEK <script>")).not.toBeNull();
  });
  it("validates segments, acres and dates", () => {
    expect(segmentProblem("1244")).toBeNull();
    expect(segmentProblem("0206C")).toBeNull();
    expect(segmentProblem("12")).not.toBeNull();
    expect(segmentProblem("0206c")).not.toBeNull();
    expect(acresProblem(304)).toBeNull();
    expect(acresProblem(0)).not.toBeNull();
    expect(acresProblem(20001)).not.toBeNull();
    expect(acresProblem(Number.NaN)).not.toBeNull();
    expect(dateProblem("2026-09-01")).toBeNull();
    expect(dateProblem("2026-02-30")).not.toBeNull();
    expect(dateProblem("09/01/2026")).not.toBeNull();
  });
});

describe("titleCase and buildProposedPatch", () => {
  it("title-cases, keeps route prefixes, apostrophes and Mc", () => {
    expect(titleCase("BRUSHY CREEK")).toBe("Brushy Creek");
    expect(titleCase("FM 1960 DITCH")).toBe("FM 1960 Ditch");
    expect(titleCase("CR220 BRANCH")).toBe("CR220 Branch");
    expect(titleCase("US 290 DRAW")).toBe("US 290 Draw");
    expect(titleCase("O'BRIEN CREEK")).toBe("O'Brien Creek");
    expect(titleCase("MCKINNEY BRANCH")).toBe("McKinney Branch");
    expect(titleCase("SMITH'S CREEK")).toBe("Smith's Creek");
    expect(titleCase("US SPRINGS")).toBe("Us Springs");
    expect(titleCase("IH-35 DITCH")).toBe("IH-35 Ditch");
    expect(titleCase("SH 71 TRIBUTARY")).toBe("SH 71 Tributary");
    expect(titleCase("HWY 183 CREEK")).toBe("HWY 183 Creek");
    expect(titleCase("ST. MARY'S RIVER")).toBe("St. Mary's River");
    expect(titleCase("MC CREEK")).toBe("Mc Creek");
    expect(titleCase("  LITTLE   ELM  CREEK ")).toBe("  Little   Elm  Creek ");
  });
  it("builds the Black Chamber-shaped patch with a status flag", () => {
    const { patch, flags } = buildProposedPatch(facility(), summary({ segment: "0828" }), TODAY);
    expect(patch).toEqual({
      disturbedAcres: 304,
      receivingWater: { name: "Brushy Creek", segment: "0828" },
      expectedCompletion: "2028-10-01",
    });
    expect(flags).toHaveLength(1);
  });
  it("proposes only what the record lacks", () => {
    const f = facility({ construction: { disturbedAcres: { value: 9, sourceIndex: 0 }, expectedCompletion: { date: "2029-01-01", sourceIndex: 0 } } });
    expect(Object.keys(buildProposedPatch(f, summary(), "2026-08-01").patch).sort()).toEqual(["expectedStart", "receivingWater"]);
  });
});

describe("guarded", () => {
  it("aborts at the request cap", async () => {
    const g = guarded(async () => 1, "x", 2);
    await g();
    await g();
    await expect(g()).rejects.toBeInstanceOf(RunAborted);
  });
  it("aborts after consecutive errors but not on expected ones, and resets on success", async () => {
    let n = 0;
    const g = guarded(async () => {
      n++;
      if (n % 3 === 0) return 1;
      throw new Error("boom");
    }, "x", 100, undefined, 3);
    await expect(g()).rejects.toThrow("boom");
    await expect(g()).rejects.toThrow("boom");
    await expect(g()).resolves.toBe(1);
    await expect(g()).rejects.toThrow("boom");
    await expect(g()).rejects.toThrow("boom");
    await g();
    const h = guarded(async () => { throw new Error("narrow the search"); }, "y", 100, /narrow the search/, 2);
    for (let i = 0; i < 5; i++) await expect(h()).rejects.toThrow("narrow");
    const k = guarded(async () => { throw new Error("boom"); }, "z", 100, undefined, 2);
    await expect(k()).rejects.toThrow("boom");
    await expect(k()).rejects.toBeInstanceOf(RunAborted);
  });
});

describe("todayIso", () => {
  it("uses the Texas calendar date, not UTC", () => {
    expect(todayIso(new Date("2026-11-14T00:09:00Z"))).toBe("2026-11-13");
    expect(todayIso(new Date("2026-11-14T12:00:00Z"))).toBe("2026-11-14");
  });
});

describe("assertSafeOut", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "tceq-out-"));
    dirs.push(d);
    return d;
  };

  it("requires a .json extension", () => {
    expect(() => assertSafeOut("x.txt")).toThrow(UsageError);
  });
  it("accepts a fresh path and returns the .md path", () => {
    const d = tmp();
    expect(assertSafeOut(path.join(d, "r.json"))).toBe(path.join(d, "r.md"));
  });
  it("refuses to overwrite a snapshot or any non-review file", () => {
    const d = tmp();
    const snap = path.join(d, "facilities.json");
    writeFileSync(snap, JSON.stringify([{ id: "x" }]));
    expect(() => assertSafeOut(snap)).toThrow(/not a previous TCEQ review/);
    writeFileSync(path.join(d, "meta.json"), JSON.stringify({ asOf: "x", recordCount: 1 }));
    expect(() => assertSafeOut(path.join(d, "meta.json"))).toThrow(UsageError);
    const fresh = path.join(d, "r.json");
    writeFileSync(path.join(d, "r.md"), "not mine");
    expect(() => assertSafeOut(fresh)).toThrow(/r\.md/);
  });
  it("allows overwriting a previous review output", () => {
    const d = tmp();
    const out = path.join(d, "r.json");
    writeFileSync(out, JSON.stringify({ generatedAt: "2026-11-13", stats: {}, facilities: [] }));
    writeFileSync(path.join(d, "r.md"), "# TCEQ known-site review (2026-11-13)\n");
    expect(assertSafeOut(out)).toBe(path.join(d, "r.md"));
  });
  it("refuses a symlink pointing at a snapshot", () => {
    const d = tmp();
    const snap = path.join(d, "facilities.json");
    writeFileSync(snap, "[]");
    const link = path.join(d, "link.json");
    symlinkSync(snap, link);
    expect(() => assertSafeOut(link)).toThrow(UsageError);
  });
});

describe("retryOnce", () => {
  it("retries a transient TceqRequestError once", async () => {
    let n = 0;
    const flaky = retryOnce(async () => {
      if (n++ === 0) throw new TceqRequestError("network", "x");
      return "ok";
    });
    await expect(flaky()).resolves.toBe("ok");
    const dead = vi.fn(async () => {
      throw new TceqRequestError("timeout", "x");
    });
    await expect(retryOnce(dead)()).rejects.toThrow("x");
    expect(dead).toHaveBeenCalledTimes(2);
  });
  it("never retries a permanent TceqRequestError or a plain Error", async () => {
    const permanent = vi.fn(async () => {
      throw new TceqRequestError("http", "gone", 404);
    });
    await expect(retryOnce(permanent)()).rejects.toThrow("gone");
    expect(permanent).toHaveBeenCalledTimes(1);
    const plain = vi.fn(async () => {
      throw new Error("narrow the search");
    });
    await expect(retryOnce(plain)()).rejects.toThrow("narrow");
    expect(plain).toHaveBeenCalledTimes(1);
  });
  it("counts the retry against the request cap when composed with guarded", async () => {
    const fn = vi.fn(async () => {
      throw new TceqRequestError("network", "x");
    });
    await expect(retryOnce(guarded(fn, "search", 1))()).rejects.toBeInstanceOf(RunAborted);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("implausible dates", () => {
  it("does not propose a date beyond ten years and does not echo it", () => {
    const { patch, notProposed } = buildProposedPatch(facility(), summary({ estimatedEnd: "2055-11-10" }), TODAY);
    expect(patch.expectedCompletion).toBeUndefined();
    expect(notProposed).toEqual(["estimated end: implausible date"]);
    expect(JSON.stringify(notProposed)).not.toContain("2055");
  });
  it("allows exactly +10 years and refuses one day more", () => {
    expect(buildProposedPatch(facility(), summary({ estimatedEnd: "2036-11-13" }), TODAY).patch.expectedCompletion).toBe("2036-11-13");
    expect(buildProposedPatch(facility(), summary({ estimatedEnd: "2036-11-14" }), TODAY).patch.expectedCompletion).toBeUndefined();
    expect(beyondHorizon("2036-11-13", TODAY)).toBe(false);
    expect(beyondHorizon("2036-11-14", TODAY)).toBe(true);
  });
  it("hides an implausible date from the review display too", async () => {
    const d = {
      search: vi.fn(async () => ({ rows: [row()] })),
      fetchSummary: liveSummaries({ TXR15AAAA: { estimatedEnd: "2055-11-10" } }),
      today: TODAY,
      log: vi.fn(),
    };
    const r = await buildReviewList([facility()], { since: "2024-01-01", statuses: ["proposed"], includeFilled: false, maxSummaries: 5, maxSummariesPerFacility: 4 }, d);
    expect(JSON.stringify(r)).not.toContain("2055");
    expect(renderMarkdown(r)).not.toContain("2055");
  });
  it("applies the same horizon in apply mode", async () => {
    const f = JSON.parse(JSON.stringify(facility())) as Record<string, unknown>;
    const { records } = await applyApproved(
      [f],
      { facilities: [{ id: f.id, facilityName: f.name, candidates: [{ permitNumber: "TXR15AAAA", summaryUrl: URL_A, approved: true }] }] },
      TODAY,
      liveSummaries({ TXR15AAAA: { estimatedEnd: "2055-11-10" } }),
    );
    expect((records[0] as { construction: Record<string, unknown> }).construction.expectedCompletion).toBeUndefined();
  });
});

describe("shared request budget", () => {
  it("makes --max-searches a true total across wrapped functions", async () => {
    const budget = requestBudget(3);
    const a = guarded(async () => "a", "search", budget);
    const b = guarded(async () => "b", "summary fetch", budget);
    await a();
    await b();
    await a();
    await expect(b()).rejects.toBeInstanceOf(RunAborted);
    await expect(a()).rejects.toThrow(/request cap of 3/);
    expect(budget.used).toBe(5);
  });
});

describe("run (exit codes)", () => {
  it("prints one line and exits 2 for a usage error, without a stack trace", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(run(["--bogus"])).resolves.toBe(2);
      expect(err).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledWith("error: unknown argument: --bogus");
      await expect(run(["--statuses=nope"])).resolves.toBe(2);
    } finally {
      err.mockRestore();
    }
  });
  it("exits 1 for other failures", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(run(["--apply-approved", "/nonexistent/review.json"])).resolves.toBe(1);
    } finally {
      err.mockRestore();
    }
  });
});

describe("main", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("refuses an --out that would overwrite the snapshot, before any network", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "tceq-main-"));
    dirs.push(d);
    const snap = path.join(d, "facilities.json");
    writeFileSync(snap, JSON.stringify([facility()]));
    await expect(main([`--out=${snap}`])).rejects.toBeInstanceOf(UsageError);
    expect(JSON.parse(readFileSync(snap, "utf8"))[0].id).toBe("example-campus-bastrop-tx");
    await expect(main(["--out=notes.txt"])).rejects.toBeInstanceOf(UsageError);
  });
});

type Rec = { sources: unknown[]; lastUpdated: string; construction: Record<string, Record<string, unknown>> };

describe("applyApproved", () => {
  const raw = (over: Record<string, unknown> = {}) => JSON.parse(JSON.stringify(facility(over))) as Record<string, unknown>;
  const NAME = "Project Example Data Center Campus";
  const review = (cands: unknown[], id = "example-campus-bastrop-tx", facilityName = NAME) => ({
    facilities: [{ id, facilityName, candidates: cands }],
  });
  const cand = (over: Record<string, unknown> = {}) => ({ permitNumber: "TXR15AAAA", summaryUrl: URL_A, approved: true, ...over });

  it("rebuilds from the live summary: source appended, indexed fields set, lastUpdated bumped only when changed", async () => {
    const other = raw({ id: "other-tx" });
    const fetchSummary = liveSummaries();
    const { records, report } = await applyApproved([raw(), other], review([cand()]), TODAY, fetchSummary);
    const r = records[0] as unknown as Rec;
    expect(r.sources).toHaveLength(2);
    expect(r.sources[1]).toEqual({
      url: URL_A,
      label: "TCEQ stormwater construction permit TXR15AAAA",
      publisher: "Texas Commission on Environmental Quality",
      retrievedAt: TODAY,
      kind: "permit",
    });
    expect(r.construction.disturbedAcres).toEqual({ value: 304, sourceIndex: 1 });
    expect(r.construction.receivingWater).toEqual({ name: "Brushy Creek", segment: "1244", sourceIndex: 1 });
    expect(r.construction.expectedCompletion).toEqual({ date: "2028-10-01", sourceIndex: 1 });
    expect(r.construction.expectedStart).toBeUndefined();
    expect(r.lastUpdated).toBe(TODAY);
    expect(records[1]).toBe(other);
    expect(facilitySchema.safeParse(r).success).toBe(true);
    expect(v2SourceIndexRefs(r as unknown as Parameters<typeof v2SourceIndexRefs>[0]).every((x) => x.index < r.sources.length)).toBe(true);
    expect(report.changed[0].patch.disturbedAcres).toBe(304);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
  });

  it("ignores every value in the review file: a tampered patch changes nothing", async () => {
    const tampered = cand({
      patch: { disturbedAcres: 999999, receivingWater: { name: "Evil <b>", segment: "x" } },
      disturbedAcres: 5,
      receivingWater: "EVIL",
    });
    const { records } = await applyApproved([raw()], review([tampered]), TODAY, liveSummaries());
    const r = records[0] as unknown as Rec;
    expect(r.construction.disturbedAcres.value).toBe(304);
    expect(r.construction.receivingWater.name).toBe("Brushy Creek");
  });

  it("does not publish a live value that fails a validator", async () => {
    const { records } = await applyApproved([raw()], review([cand()]), TODAY, liveSummaries({ TXR15AAAA: { receivingWater: "DISCHARGES TO NORTH CREEK" } }));
    const r = records[0] as unknown as Rec;
    expect(r.construction.receivingWater).toBeUndefined();
    expect(r.construction.disturbedAcres.value).toBe(304);
  });

  it("refuses when the facility name changed since the review", async () => {
    await expect(applyApproved([raw({ name: "Renamed Campus" })], review([cand()]), TODAY, liveSummaries())).rejects.toThrow(/no longer has the name/);
    await expect(applyApproved([raw()], { facilities: [{ id: "example-campus-bastrop-tx", candidates: [cand()] }] }, TODAY, liveSummaries())).rejects.toThrow(/malformed/);
  });

  it("refuses on a URL that is off-origin, lacks the ident, or names another permit", async () => {
    const f = liveSummaries();
    await expect(applyApproved([raw()], review([cand({ summaryUrl: "https://evil.example/x" })]), TODAY, f)).rejects.toThrow(/non-TCEQ/);
    await expect(applyApproved([raw()], review([cand({ summaryUrl: urlFor("TXR15BBBB") })]), TODAY, f)).rejects.toThrow(/does not carry/);
    await expect(
      applyApproved([raw()], review([cand({ summaryUrl: "https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary" })]), TODAY, f),
    ).rejects.toThrow(/does not carry/);
    await expect(applyApproved([raw()], review([cand({ summaryUrl: urlFor("TXR15AAAA", "&lgl_ident_txt=TXR15BBBB") })]), TODAY, f)).rejects.toThrow(/does not carry/);
    await expect(applyApproved([raw()], review([cand({ permitNumber: "txr15aaaa", summaryUrl: urlFor("txr15aaaa") })]), TODAY, f)).rejects.toThrow(/malformed permit/);
    expect(f).not.toHaveBeenCalled();
  });

  it("accepts a URL with extra params when the client guard allows it and the ident matches", async () => {
    const url = urlFor("TXR15AAAA", "&lgl_id=1&pita_id=2");
    const { records } = await applyApproved([raw()], review([cand({ summaryUrl: url })]), TODAY, liveSummaries());
    expect(((records[0] as unknown as Rec).sources[1] as { url: string }).url).toBe(url);
  });

  it("refuses when the live page is a different permit", async () => {
    const f = vi.fn(async () => summary({ permitNumber: "TXR15ZZZZ" }));
    await expect(applyApproved([raw()], review([cand()]), TODAY, f)).rejects.toThrow(/different permit/);
  });

  it("reuses a source with the same URL", async () => {
    const f = raw();
    (f.sources as unknown[]).push({ url: URL_A, label: "x", retrievedAt: "2026-11-01", kind: "permit" });
    const { records } = await applyApproved([f], review([cand()]), TODAY, liveSummaries());
    const r = records[0] as unknown as Rec;
    expect(r.sources).toHaveLength(2);
    expect(r.construction.disturbedAcres.sourceIndex).toBe(1);
  });

  it("never overwrites an existing value and reports the conflict", async () => {
    const f = raw({ construction: { disturbedAcres: { value: 9, sourceIndex: 0 } } });
    const { records, report } = await applyApproved([f], review([cand()]), TODAY, liveSummaries());
    const r = records[0] as unknown as Rec;
    expect(r.construction.disturbedAcres).toEqual({ value: 9, sourceIndex: 0 });
    expect(r.construction.receivingWater.name).toBe("Brushy Creek");
    expect(report.conflicts).toHaveLength(1);
  });

  it("leaves a record untouched when everything conflicts", async () => {
    const f = raw({
      construction: {
        disturbedAcres: { value: 9, sourceIndex: 0 },
        receivingWater: { name: "Old Creek", sourceIndex: 0 },
        expectedCompletion: { date: "2029-01-01", sourceIndex: 0 },
      },
    });
    const { records, report } = await applyApproved([f], review([cand()]), TODAY, liveSummaries());
    expect(records[0]).toBe(f);
    expect(report.changed).toEqual([]);
  });

  it("skips unapproved candidates without fetching", async () => {
    const f = raw();
    const fetchSummary = liveSummaries();
    const { records } = await applyApproved([f], review([cand({ approved: false })]), TODAY, fetchSummary);
    expect(records[0]).toBe(f);
    expect(fetchSummary).not.toHaveBeenCalled();
  });

  it("refuses malformed permit numbers and non-string ones", async () => {
    const f = liveSummaries();
    for (const permitNumber of ["TXR15", "TXR15A", "TXR15AB/../X", "TXR15ABCDEFGHIJKLM", "TXR14AAAA", 15, null]) {
      await expect(applyApproved([raw()], review([cand({ permitNumber, summaryUrl: URL_A })]), TODAY, f)).rejects.toThrow(/malformed permit/);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses the same permit approved for more than one facility, naming only the permit and ids", async () => {
    const two = {
      facilities: [
        { id: "example-campus-bastrop-tx", facilityName: NAME, candidates: [cand()] },
        { id: "other-tx", facilityName: NAME, candidates: [cand()] },
      ],
    };
    const f = liveSummaries();
    const err = await applyApproved([raw(), raw({ id: "other-tx" })], two, TODAY, f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("permit TXR15AAAA is approved for more than one facility: example-campus-bastrop-tx, other-tx");
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses the same permit approved twice for one facility", async () => {
    await expect(applyApproved([raw()], review([cand(), cand()]), TODAY, liveSummaries())).rejects.toThrow(/approved twice/);
  });

  it("ignores a non-string segment in a tampered entry and writes the live string", async () => {
    const tampered = cand({ patch: { receivingWater: { name: "Brushy Creek", segment: 1244 } }, segment: 1244 });
    const { records } = await applyApproved([raw()], review([tampered]), TODAY, liveSummaries());
    const r = records[0] as unknown as Rec;
    expect(r.construction.receivingWater.segment).toBe("1244");
    expect(facilitySchema.safeParse(r).success).toBe(true);
  });

  it("applies two approved candidates that target DIFFERENT fields of one facility", async () => {
    const noDates = { estimatedStart: undefined, estimatedEnd: undefined };
    const f = liveSummaries({
      TXR15AAAA: { ...noDates, receivingWater: undefined, segment: undefined },
      TXR15BBBB: { ...noDates, areaDisturbedAcres: undefined },
    });
    const { records, report } = await applyApproved([raw()], review([cand(), cand({ permitNumber: "TXR15BBBB", summaryUrl: URL_B })]), TODAY, f);
    const r = records[0] as unknown as Rec;
    expect(r.sources).toHaveLength(3);
    expect(r.construction.disturbedAcres.sourceIndex).toBe(1);
    expect(r.construction.receivingWater.sourceIndex).toBe(2);
    expect(report.changed).toHaveLength(1);
    expect(facilitySchema.safeParse(r).success).toBe(true);
  });

  it("is a substantive update for db:sync, never editorial", async () => {
    const before = facility();
    const { records } = await applyApproved([raw()], review([cand()]), TODAY, liveSummaries());
    const after = facilitySchema.parse(records[0]);
    expect(isEditorialOnlyChange(before, after)).toBe(false);
    expect(after.lastUpdated).toBe(TODAY);
  });

  it("refuses everything on an invalid record, a duplicate target, or an unknown facility", async () => {
    const bad = raw();
    bad.status = "bogus";
    await expect(applyApproved([bad], review([cand()]), TODAY, liveSummaries())).rejects.toThrow(/schema/);
    await expect(
      applyApproved([raw()], review([cand(), cand({ permitNumber: "TXR15BBBB", summaryUrl: URL_B })]), TODAY, liveSummaries()),
    ).rejects.toThrow(/two approved/);
    await expect(applyApproved([raw()], review([cand()], "missing-id"), TODAY, liveSummaries())).rejects.toThrow(/unknown facility/);
  });
});

describe("applyApprovedFile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const root = mkdtempSync(path.join(os.tmpdir(), "tceq-"));
    dirs.push(root);
    mkdirSync(path.join(root, "data"));
    const meta = JSON.stringify({ asOf: "2026-11-04", recordCount: 1 });
    writeFileSync(path.join(root, "data", "facilities.json"), JSON.stringify([facility()]));
    writeFileSync(path.join(root, "data", "facilities.meta.json"), meta);
    return { root, meta };
  }
  const reviewFile = (root: string, approved: boolean) => {
    const p = path.join(root, "review.json");
    writeFileSync(
      p,
      JSON.stringify({
        facilities: [
          {
            id: "example-campus-bastrop-tx",
            facilityName: "Project Example Data Center Campus",
            candidates: [{ permitNumber: "TXR15AAAA", summaryUrl: URL_A, approved }],
          },
        ],
      }),
    );
    return p;
  };

  it("writes facilities.json only, leaving meta untouched and no temp file behind", async () => {
    const { root, meta } = setup();
    const report = await applyApprovedFile(root, reviewFile(root, true), TODAY, liveSummaries());
    expect(report.changed).toHaveLength(1);
    const written = JSON.parse(readFileSync(path.join(root, "data", "facilities.json"), "utf8"));
    expect(written[0].construction.disturbedAcres.value).toBe(304);
    expect(readFileSync(path.join(root, "data", "facilities.meta.json"), "utf8")).toBe(meta);
    expect(readdirSync(path.join(root, "data")).sort()).toEqual(["facilities.json", "facilities.meta.json"]);
  });

  it("writes nothing when a network error hits during apply", async () => {
    const { root, meta } = setup();
    const before = readFileSync(path.join(root, "data", "facilities.json"), "utf8");
    const f = vi.fn(async () => {
      throw new TceqRequestError("network", "down");
    });
    await expect(applyApprovedFile(root, reviewFile(root, true), TODAY, f)).rejects.toThrow("down");
    expect(readFileSync(path.join(root, "data", "facilities.json"), "utf8")).toBe(before);
    expect(readFileSync(path.join(root, "data", "facilities.meta.json"), "utf8")).toBe(meta);
    expect(readdirSync(path.join(root, "data")).sort()).toEqual(["facilities.json", "facilities.meta.json"]);
  });

  it("writes nothing on refusal", async () => {
    const { root } = setup();
    const before = readFileSync(path.join(root, "data", "facilities.json"), "utf8");
    const f = vi.fn(async () => summary({ permitNumber: "TXR15ZZZZ" }));
    await expect(applyApprovedFile(root, reviewFile(root, true), TODAY, f)).rejects.toThrow();
    expect(readFileSync(path.join(root, "data", "facilities.json"), "utf8")).toBe(before);
  });
});
