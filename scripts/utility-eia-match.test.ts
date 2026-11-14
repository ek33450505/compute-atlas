import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { facilitySchema } from "../lib/schema";
import { DEFAULT_EIA861_PATH, EIA861_2025, loadEia861, type Eia861Data } from "./eia861";
import { UTILITY_ALIASES, type UtilityAlias } from "./utility-aliases";
import {
  ApplyRefusal,
  UsageError,
  applyApproved,
  applyApprovedFile,
  assertSafeOut,
  buildAliasMap,
  buildEiaIndex,
  buildReview,
  classifyFacility,
  countyKeys,
  countyNorm,
  isCompoundOrHedged,
  normalizeUtilityName,
  parseArgs,
  renderMarkdown,
  validateAliases,
} from "./utility-eia-match";

// ---------------------------------------------------------------- fixture (invented names)

const provenance = { ...EIA861_2025, sha256: "a".repeat(64) };

function eia(): Eia861Data {
  return {
    provenance,
    utilities: new Map([
      [101, { id: 101, name: "Example Electric Co", state: "VA" }],
      [102, { id: 102, name: "Sample Valley Power Coop", state: "VA" }],
      [103, { id: 103, name: "Borderland Electric Cooperative", state: "NC" }],
      [104, { id: 104, name: "Widget State Power Authority", state: "NC" }],
      [201, { id: 201, name: "Brandco North", state: "VA" }],
      [202, { id: 202, name: "Brandco South", state: "VA" }],
      [301, { id: 301, name: "Bayou Parish Electric", state: "LA" }],
    ]),
    territory: [
      { id: 101, name: "Example Electric Co", state: "VA", county: "Fairfax" },
      { id: 101, name: "Example Electric Co", state: "VA", county: "Chesapeake City" },
      { id: 102, name: "Sample Valley Power Coop", state: "VA", county: "Loudoun" },
      { id: 103, name: "Borderland Electric Cooperative", state: "NC", county: "Wake" },
      { id: 103, name: "Borderland Electric Cooperative", state: "VA", county: "Fairfax" },
      { id: 201, name: "Brandco North", state: "VA", county: "Loudoun" },
      { id: 202, name: "Brandco South", state: "VA", county: "Fairfax" },
      { id: 301, name: "Bayou Parish Electric", state: "LA", county: "St Charles" },
    ],
    salesBa: [{ id: 104, state: "NC", part: "A", serviceType: "Bundled", baCode: "XX" }],
  };
}

const idx = buildEiaIndex(eia());

const ALIASES: UtilityAlias[] = [
  { state: "VA", name: "Brandco", eiaIds: [201, 202] },
  { state: "VA", name: "Brandco Fairfax", eiaIds: [201, 202] },
];

type F = { id: string; name: string; state: string; county?: string; utility?: string; eiaId?: number };

function rec(f: F) {
  return {
    id: f.id,
    name: f.name,
    location: { state: f.state, ...(f.county ? { county: f.county } : {}) },
    energy: { ...(f.utility ? { utility: f.utility } : {}), ...(f.eiaId ? { utilityEiaId: { id: f.eiaId, sourceIndex: 0 } } : {}) },
  };
}

const aliasMap = buildAliasMap(ALIASES);
const cls = (f: F) => classifyFacility(rec(f) as Parameters<typeof classifyFacility>[0], idx, aliasMap);

// A schema-valid raw record for apply tests.
function raw(id: string, utility: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Test Site ${id}`,
    facilityType: "data_center",
    operator: "Invented Operator",
    status: "operational",
    confidence: "confirmed",
    location: { state: "VA", county: "Fairfax", lat: 38.9, lon: -77.4, precision: "approximate" },
    sources: [{ url: "https://example.org/a", label: "A", retrievedAt: "2026-01-01", kind: "other" }],
    energy: { utility },
    lastUpdated: "2026-01-01",
    ...extra,
  };
}

describe("raw fixture is schema-valid", () => {
  it("parses", () => {
    const r = facilitySchema.safeParse(raw("x-1", "Example Electric Co"));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------- normalization

describe("normalizeUtilityName", () => {
  it("treats the documented variants as one key", () => {
    expect(normalizeUtilityName("Pacific Gas & Electric (PG&E)")).toBe(normalizeUtilityName("Pacific Gas & Electric Co."));
    expect(normalizeUtilityName("Rappahannock Electric Co-op")).toBe(normalizeUtilityName("Rappahannock Electric Coop"));
    expect(normalizeUtilityName("Public Service Company of Oklahoma (PSO)")).toBe(normalizeUtilityName("Public Service Co of Oklahoma"));
  });
  it("keeps a parenthetical that is not a bare acronym", () => {
    expect(normalizeUtilityName("Ohio Edison (FirstEnergy)")).toBe("ohio edison firstenergy");
    expect(normalizeUtilityName("Ohio Edison (pge)")).toBe("ohio edison pge");
  });
});

describe("normalizeUtilityName prototype tokens", () => {
  it("does not read Object.prototype", () => {
    expect(normalizeUtilityName("constructor toString")).toBe("constructor tostring");
  });
});

describe("isCompoundOrHedged", () => {
  it.each([
    "Santee Cooper and Dominion Energy",
    "Tri-County EMC or Georgia Power Company",
    "Cass County Electric Cooperative / Minnkota Power Cooperative",
    "Duke Energy (Belews Creek proximity; no confirmed interconnection)",
    "PJM (via FirstEnergy)",
    "Brandco North with Brandco South",
    "Brandco North + Brandco South",
  ])("true: %s", (s) => expect(isCompoundOrHedged(s)).toBe(true));
  it.each(["Louisville Gas and Electric", "Kansas City Power and Light", "Dominion Energy"])("false: %s", (s) =>
    expect(isCompoundOrHedged(s)).toBe(false),
  );
});

describe("county keys", () => {
  it("matches Virginia independent cities", () => {
    expect(countyKeys("VA", "Chesapeake (independent city)")).toContain(countyNorm("Chesapeake City"));
  });
  it("maps independent cities to the city key only", () => {
    expect(countyKeys("VA", "Bedford County")).toEqual(["bedford"]);
    expect(countyKeys("VA", "Richmond (independent city)")).toEqual(["richmondcity"]);
    const data = eia();
    data.territory.push(
      { id: 901, name: "Bedford City Power", state: "VA", county: "Bedford City" },
      { id: 902, name: "Charles City Power", state: "VA", county: "Charles City" },
      { id: 903, name: "Chesapeake Power", state: "VA", county: "Chesapeake City" },
      { id: 904, name: "Richmond County Power", state: "VA", county: "Richmond" },
      { id: 905, name: "Richmond City Power", state: "VA", county: "Richmond City" },
      { id: 906, name: "Carson Power", state: "NV", county: "Carson City" },
      { id: 907, name: "Baltimore City Power", state: "MD", county: "Baltimore City" },
    );
    const i = buildEiaIndex(data);
    const serving = (state: string, county: string) =>
      new Set(countyKeys(state, county).flatMap((k) => [...(i.countyServing.get(`${state}|${k}`) ?? [])]));
    expect(serving("VA", "Bedford County").has(901)).toBe(false);
    expect(serving("VA", "Chesapeake (independent city)").has(903)).toBe(true);
    expect(serving("VA", "Charles City").has(902)).toBe(true);
    expect(serving("VA", "Richmond (independent city)").has(904)).toBe(false);
    expect(serving("VA", "Richmond (independent city)").has(905)).toBe(true);
    expect(serving("NV", "Carson City").has(906)).toBe(true);
    expect(serving("MD", "Baltimore city").has(907)).toBe(true);
  });
  it("matches saint and borough forms", () => {
    expect(countyNorm("St. Charles Parish")).toBe(countyNorm("St Charles"));
    expect(countyNorm("Saint Charles Parish")).toBe(countyNorm("St Charles"));
    expect(countyNorm("Municipality of Anchorage")).toBe(countyNorm("Anchorage"));
  });
  it("handles a missing county", () => {
    expect(countyKeys("DC", undefined)).toEqual([countyNorm("District of Columbia")]);
    expect(countyKeys("VA", undefined)).toEqual([]);
    expect(countyKeys("VA", "  ")).toEqual([]);
  });
});

// ---------------------------------------------------------------- index + classify

describe("buildEiaIndex", () => {
  it("presence is territory union salesBa", () => {
    expect(idx.presence.has("103|VA")).toBe(true); // home NC, territory in VA
    expect(idx.presence.has("104|NC")).toBe(true); // sales only
    expect(idx.territoryStates.has("104|NC")).toBe(false);
    expect(idx.presence.has("101|NC")).toBe(false);
  });
  it("names fall back to territory then ?", () => {
    expect(idx.nameOf(101)).toBe("Example Electric Co");
    expect(idx.nameOf(999999)).toBe("?");
  });
});

describe("classifyFacility", () => {
  it("exact + county ok", () => {
    expect(cls({ id: "a", name: "A", state: "VA", county: "Fairfax", utility: "Example Electric Company" })).toMatchObject({
      status: "proposed", tier: "exact", check: "county_ok", eiaId: 101,
    });
  });
  it("exact + county mismatch", () => {
    expect(cls({ id: "a", name: "A", state: "VA", county: "Loudoun", utility: "Example Electric Co" })).toMatchObject({
      status: "flagged", check: "county_mismatch", eiaId: 101,
    });
  });
  it("exact + county unknown", () => {
    expect(cls({ id: "a", name: "A", state: "VA", utility: "Example Electric Co" })).toMatchObject({ status: "flagged", check: "county_unknown" });
    expect(cls({ id: "a", name: "A", state: "VA", county: "Nowhere", utility: "Example Electric Co" })).toMatchObject({ check: "county_unknown" });
  });
  it("finds a utility whose home state differs", () => {
    expect(cls({ id: "a", name: "A", state: "VA", county: "Fairfax", utility: "Borderland Electric Cooperative" })).toMatchObject({
      status: "proposed", eiaId: 103,
    });
  });
  it("sales-only utility has no county data", () => {
    expect(cls({ id: "a", name: "A", state: "NC", county: "Wake", utility: "Widget State Power Authority" })).toMatchObject({
      status: "flagged", check: "no_county_data", eiaId: 104,
    });
  });
  it("matches Louisiana parish to EIA county", () => {
    expect(cls({ id: "a", name: "A", state: "LA", county: "St. Charles Parish", utility: "Bayou Parish Electric" })).toMatchObject({
      status: "proposed", eiaId: 301,
    });
  });
  it("alias with two ids is disambiguated by county", () => {
    expect(cls({ id: "a", name: "A", state: "VA", county: "Fairfax", utility: "Brandco" })).toMatchObject({
      status: "proposed", tier: "alias", check: "county_disambiguated", eiaId: 202,
    });
    expect(cls({ id: "a", name: "A", state: "VA", county: "Loudoun", utility: " brandco " })).toMatchObject({
      status: "proposed", check: "county_disambiguated", eiaId: 201,
    });
  });
  it("alias stays ambiguous when both serve the county, or none does", () => {
    const r = cls({ id: "a", name: "A", state: "VA", county: "Nowhere", utility: "Brandco" });
    expect(r).toMatchObject({ status: "ambiguous", candidates: [201, 202] });
    const both = buildEiaIndex({
      ...eia(),
      territory: [...eia().territory, { id: 201, name: "Brandco North", state: "VA", county: "Fairfax" }],
    });
    const r2 = classifyFacility(rec({ id: "a", name: "A", state: "VA", county: "Fairfax", utility: "Brandco" }) as Parameters<typeof classifyFacility>[0], both, aliasMap);
    expect(r2).toMatchObject({ status: "ambiguous", candidates: [201, 202] });
  });
  it("compound strings and unknown names are unmatched", () => {
    expect(cls({ id: "a", name: "A", state: "VA", county: "Fairfax", utility: "Example Electric Co or Brandco North" })).toMatchObject({
      status: "unmatched", reason: "compound_or_hedged",
    });
    expect(cls({ id: "a", name: "A", state: "VA", county: "Fairfax", utility: "Nonexistent Light" })).toMatchObject({
      status: "unmatched", reason: "no_name_match",
    });
  });
  it("name match is filtered to the facility's state", () => {
    expect(cls({ id: "a", name: "A", state: "NC", county: "Wake", utility: "Example Electric Co" })).toMatchObject({ reason: "no_name_match" });
  });
  it("an alias beats the compound check", () => {
    const m = buildAliasMap([{ state: "VA", name: "Brandco / Example", eiaIds: [101] }]);
    const r = classifyFacility(rec({ id: "a", name: "A", state: "VA", county: "Fairfax", utility: "Brandco / Example" }) as Parameters<typeof classifyFacility>[0], idx, m);
    expect(r).toMatchObject({ status: "proposed", tier: "alias" });
  });
  it("skips already set and no utility", () => {
    expect(cls({ id: "a", name: "A", state: "VA", utility: "Example Electric Co", eiaId: 101 })).toBe("already_set");
    expect(cls({ id: "a", name: "A", state: "VA" })).toBe("no_utility");
  });
});

describe("validateAliases", () => {
  it("passes a good table", () => expect(() => validateAliases(ALIASES, idx)).not.toThrow());
  it("throws on an id absent from the state", () => {
    expect(() => validateAliases([{ state: "NC", name: "X", eiaIds: [101] }], idx)).toThrow(/101 is not present in NC/);
  });
  it("throws on duplicates and empty id lists, listing every problem", () => {
    const bad: UtilityAlias[] = [
      { state: "VA", name: "Dup", eiaIds: [101] },
      { state: "VA", name: " dup ", eiaIds: [101] },
      { state: "VA", name: "Empty", eiaIds: [] },
      { state: "Va", name: "BadState", eiaIds: [101] },
    ];
    let msg = "";
    try {
      validateAliases(bad, idx);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/duplicate/);
    expect(msg).toMatch(/no eiaIds/);
    expect(msg).toMatch(/not two capital letters/);
  });
});

// ---------------------------------------------------------------- review

function facilities() {
  const mk = (id: string, utility: string, county = "Fairfax", state = "VA") => {
    const r = raw(id, utility, { location: { state, county, lat: 38.9, lon: -77.4, precision: "approximate" } });
    return facilitySchema.parse(r);
  };
  return [
    mk("f1", "Example Electric Co"),
    mk("f2", "Example Electric Co"),
    mk("f3", "Example Electric Co", "Loudoun"),
    mk("f4", "Brandco", "Nowhere"),
    mk("f5", "Example Electric Co or Brandco"),
    facilitySchema.parse(raw("f6", "Example Electric Co", { energy: { utility: "Example Electric Co", utilityEiaId: { id: 101, sourceIndex: 0 } } })),
    facilitySchema.parse({ ...raw("f7", "x"), energy: {} }),
  ];
}

describe("buildReview / renderMarkdown", () => {
  const review = buildReview(facilities(), eia(), { snapshotAsOf: "2026-11-14T00:00:00Z", generatedAt: "t" }, ALIASES);
  it("counts records", () => {
    expect(review.counts).toEqual({ withUtility: 6, alreadySet: 1, proposed: 2, flagged: 1, ambiguous: 1, unmatched: 1 });
  });
  it("groups and sorts proposed, flagged, ambiguous, unmatched", () => {
    expect(review.groups.map((g) => g.status)).toEqual(["proposed", "flagged", "ambiguous", "unmatched"]);
    expect(review.groups[0].records.map((r) => r.id)).toEqual(["f1", "f2"]);
    expect(review.groups.every((g) => g.approved === false)).toBe(true);
    expect(new Set(review.groups.map((g) => g.key)).size).toBe(review.groups.length);
    expect(review.groups[2].candidates).toEqual([
      { id: 201, name: "Brandco North" },
      { id: 202, name: "Brandco South" },
    ]);
  });
  it("renders one line per group with the heading and no facility ids", () => {
    const md = renderMarkdown(review);
    expect(md.startsWith("# Utility EIA-861 match review")).toBe(true);
    const lines = md.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(review.groups.length);
    expect(lines[0]).toBe("- [ ] 2 · VA · Example Electric Co → Example Electric Co (101) · exact · county_ok");
    expect(md).not.toMatch(/f1|Test Site/);
  });
});

// ---------------------------------------------------------------- apply

const TODAY = "2026-11-14";
const PAGE = provenance.pageUrl;

function reviewFor(groups: Record<string, unknown>[], sha = provenance.sha256) {
  return { kind: "utility-eia-review", provenance: { sha256: sha }, groups };
}
const grp = (over: Record<string, unknown>) => ({
  state: "VA", utility: "Example Electric Co", status: "proposed", check: "county_ok", eiaId: 101, approved: true,
  records: [{ id: "r1", county: "Fairfax" }], ...over,
});
const apply = (records: Record<string, unknown>[], groups: Record<string, unknown>[], sha?: string, aliases: readonly UtilityAlias[] = ALIASES) =>
  applyApproved(records, reviewFor(groups, sha), idx, eia(), TODAY, aliases);
const loc = (county: string) => ({ location: { state: "VA", county, lat: 38.9, lon: -77.4, precision: "approximate" } });
const ambiguousGroup = (over: Record<string, unknown> = {}) =>
  grp({
    utility: "Brandco", status: "ambiguous", check: "ambiguous", eiaId: 202,
    candidates: [{ id: 201 }, { id: 202 }], records: [{ id: "r1", county: "Nowhere" }], ...over,
  });
const brandco = () => raw("r1", "Brandco", loc("Nowhere"));

describe("applyApproved", () => {
  it("sets utilityEiaId, appends a source, bumps lastUpdated, changes nothing else", () => {
    const orig = raw("r1", "Example Electric Co");
    const snapshot = JSON.parse(JSON.stringify(orig));
    const { records, report } = apply([orig], [grp({})]);
    expect(orig).toEqual(snapshot); // input not mutated
    const out = records[0] as Record<string, unknown>;
    expect(out.energy).toEqual({ utility: "Example Electric Co", utilityEiaId: { id: 101, sourceIndex: 1 } });
    expect((out.sources as unknown[])[1]).toMatchObject({ url: PAGE, publisher: "U.S. Energy Information Administration", retrievedAt: TODAY, kind: "other" });
    expect(out.lastUpdated).toBe(TODAY);
    const strip = (o: Record<string, unknown>) => {
      const c = { ...o };
      for (const k of ["energy", "sources", "lastUpdated"]) delete c[k];
      return c;
    };
    expect(strip(out)).toEqual(strip(snapshot));
    expect(report.changed).toEqual([{ id: "r1", eiaId: 101, addedSource: true }]);
  });
  it("reuses an existing source with the same url", () => {
    const r = raw("r1", "Example Electric Co", {
      sources: [{ url: PAGE, label: "EIA", retrievedAt: "2026-01-01", kind: "other" }],
    });
    const { records, report } = apply([r], [grp({})]);
    const out = records[0] as { sources: unknown[]; energy: { utilityEiaId: unknown } };
    expect(out.sources).toHaveLength(1);
    expect(out.energy.utilityEiaId).toEqual({ id: 101, sourceIndex: 0 });
    expect(report.changed[0].addedSource).toBe(false);
  });
  it("skips groups with approved false or absent", () => {
    for (const approved of [false, undefined]) {
      const { records, report } = apply([raw("r1", "Example Electric Co")], [grp({ approved })]);
      expect(report.changed).toEqual([]);
      expect((records[0].energy as Record<string, unknown>).utilityEiaId).toBeUndefined();
    }
  });
  it("refuses a non-boolean approved instead of skipping it", () => {
    for (const approved of ["true", 1, null]) {
      expect(() => apply([raw("r1", "Example Electric Co")], [grp({ approved })])).toThrow(/non-boolean/);
    }
  });
  it("refuses a provenance mismatch", () => {
    expect(() => apply([raw("r1", "Example Electric Co")], [grp({})], "b".repeat(64))).toThrow(ApplyRefusal);
  });
  it("refuses a wrong kind", () => {
    expect(() => applyApproved([], { kind: "other", provenance: { sha256: provenance.sha256 }, groups: [] }, idx, eia(), TODAY)).toThrow(ApplyRefusal);
  });
  it("refuses an unknown record id", () => {
    expect(() => apply([raw("r1", "Example Electric Co")], [grp({ records: [{ id: "nope", county: "Fairfax" }] })])).toThrow(/unknown facility/);
  });
  it("refuses a changed utility string or state", () => {
    expect(() => apply([raw("r1", "Something Else")], [grp({})])).toThrow(/re-run the review/);
    expect(() =>
      apply([raw("r1", "Example Electric Co", { location: { state: "NC", lat: 35, lon: -78, precision: "approximate" } })], [grp({})]),
    ).toThrow(/re-run the review/);
  });
  it("refuses a record in two approved groups", () => {
    expect(() => apply([raw("r1", "Example Electric Co")], [grp({}), grp({ eiaId: 103 })])).toThrow(/more than one approved group/);
  });
  it("refuses an approved unmatched group", () => {
    expect(() => apply([raw("r1", "Example Electric Co")], [grp({ status: "unmatched", eiaId: undefined })])).toThrow(/cannot be approved/);
  });
  it("refuses an id not present in the state", () => {
    expect(() => apply([raw("r1", "Example Electric Co")], [grp({ eiaId: 301 })])).toThrow(/not present in VA/);
  });
  it("ambiguous applies only with a chosen candidate", () => {
    expect(() => apply([brandco()], [ambiguousGroup({ eiaId: undefined })])).toThrow(/candidates/);
    expect(() => apply([brandco()], [ambiguousGroup({ eiaId: 101 })])).toThrow(/candidates/);
    const { report } = apply([brandco()], [ambiguousGroup()]);
    expect(report.changed[0].eiaId).toBe(202);
  });
  it("refuses a forged status (an unmatched record edited to proposed)", () => {
    expect(() => apply([raw("r1", "Nonexistent Light")], [grp({ utility: "Nonexistent Light" })])).toThrow(/re-run the review/);
  });
  it("refuses a forged eiaId", () => {
    expect(() => apply([raw("r1", "Example Electric Co")], [grp({ eiaId: 103 })])).toThrow(/re-run the review/);
  });
  it("refuses a forged check", () => {
    expect(() => apply([raw("r1", "Example Electric Co")], [grp({ check: "county_disambiguated" })])).toThrow(/re-run the review/);
  });
  it("refuses a county changed after the review", () => {
    expect(() => apply([raw("r1", "Example Electric Co", loc("Loudoun"))], [grp({})])).toThrow(/county/);
  });
  it("refuses when the alias table now classifies the record differently", () => {
    const narrowed: UtilityAlias[] = [{ state: "VA", name: "Brandco", eiaIds: [201] }];
    expect(() => apply([brandco()], [ambiguousGroup()], undefined, narrowed)).toThrow(/re-run the review/);
  });
  it("refuses an ambiguous group whose candidate set differs from the fresh one", () => {
    expect(() => apply([brandco()], [ambiguousGroup({ candidates: [{ id: 201 }] , eiaId: 201 })])).toThrow(/re-run the review/);
  });
  it("reports a conflict and keeps the existing value", () => {
    const r = raw("r1", "Example Electric Co", {
      energy: { utility: "Example Electric Co", utilityEiaId: { id: 102, sourceIndex: 0 } },
    });
    const { records, report } = apply([r], [grp({})]);
    expect(report.changed).toEqual([]);
    expect(report.conflicts).toHaveLength(1);
    expect(records[0]).toBe(r);
  });
  it("refuses a non-object entry in sources, naming the record", () => {
    expect(() => apply([raw("r1", "Example Electric Co", { sources: [null] })], [grp({})])).toThrow(/r1 has a malformed sources/);
  });
  it("refuses everything when a patched record fails the schema", () => {
    const bad = raw("r2", "Example Electric Co", { lastUpdated: "x", operator: 5 });
    expect(() =>
      apply([raw("r1", "Example Electric Co"), bad], [grp({ records: [{ id: "r1", county: "Fairfax" }, { id: "r2", county: "Fairfax" }] })]),
    ).toThrow(/fails schema validation/);
  });
});

describe("applyApprovedFile", () => {
  const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
  function setup() {
    const root = mkdtempSync(path.join(tmpdir(), "util-eia-apply-"));
    mkdirSync(path.join(root, "data"));
    const file = path.join(root, "data", "facilities.json");
    writeFileSync(file, `${JSON.stringify([raw("r1", "Example Electric Co")], null, 2)}\n`);
    return { root, file };
  }
  const writeReview = (root: string, g: Record<string, unknown>) => {
    const f = path.join(root, "review.json");
    writeFileSync(f, JSON.stringify(reviewFor([g])));
    return f;
  };
  it("writes facilities.json on a clean apply", async () => {
    const { root, file } = setup();
    const report = await applyApprovedFile(root, writeReview(root, grp({})), TODAY, { loadData: async () => eia(), aliases: ALIASES });
    expect(report.changed).toHaveLength(1);
    const out = JSON.parse(readFileSync(file, "utf8")) as { energy: { utilityEiaId: unknown } }[];
    expect(out[0].energy.utilityEiaId).toEqual({ id: 101, sourceIndex: 1 });
  });
  it("fails closed on an invalid alias table, leaving the file untouched", async () => {
    const { root, file } = setup();
    const before = sha(file);
    await expect(
      applyApprovedFile(root, writeReview(root, grp({})), TODAY, {
        loadData: async () => eia(),
        aliases: [{ state: "NC", name: "Bad", eiaIds: [101] }],
      }),
    ).rejects.toThrow(/alias table is invalid/);
    expect(sha(file)).toBe(before);
  });
  it("leaves the file byte-identical when the apply is refused", async () => {
    const { root, file } = setup();
    const before = sha(file);
    await expect(
      applyApprovedFile(root, writeReview(root, grp({ eiaId: 103 })), TODAY, { loadData: async () => eia(), aliases: ALIASES }),
    ).rejects.toThrow(ApplyRefusal);
    expect(sha(file)).toBe(before);
  });
});

// ---------------------------------------------------------------- CLI plumbing

describe("parseArgs", () => {
  it("defaults, = and space forms", () => {
    expect(parseArgs([])).toMatchObject({ out: "data/utility-eia-review.json", eia861: DEFAULT_EIA861_PATH, applyApproved: null });
    expect(parseArgs(["--out=a.json", "--eia861", "z.zip", "--apply-approved=r.json"])).toEqual({ out: "a.json", eia861: "z.zip", applyApproved: "r.json" });
  });
  it("rejects unknown flags and missing values", () => {
    expect(() => parseArgs(["--nope"])).toThrow(UsageError);
    expect(() => parseArgs(["--out"])).toThrow(UsageError);
  });
});

describe("assertSafeOut", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "util-eia-"));
  it("requires .json", () => expect(() => assertSafeOut(path.join(dir, "x.txt"))).toThrow(UsageError));
  it("refuses to overwrite a non-review file (json or md)", () => {
    const f = path.join(dir, "facilities.json");
    writeFileSync(f, "[]");
    expect(() => assertSafeOut(f)).toThrow(/not a previous/);
    const g = path.join(dir, "g.json");
    writeFileSync(path.join(dir, "g.md"), "# something else");
    expect(() => assertSafeOut(g)).toThrow(/not a previous/);
  });
  it("accepts absent targets and previous outputs", () => {
    const f = path.join(dir, "ok.json");
    expect(assertSafeOut(f)).toBe(path.join(dir, "ok.md"));
    writeFileSync(f, JSON.stringify({ kind: "utility-eia-review" }));
    writeFileSync(path.join(dir, "ok.md"), "# Utility EIA-861 match review\n");
    expect(assertSafeOut(f)).toBe(path.join(dir, "ok.md"));
  });
});

describe("utility-aliases table", () => {
  it("is well formed", () => {
    expect(UTILITY_ALIASES).toHaveLength(108);
    const seen = new Set<string>();
    for (const a of UTILITY_ALIASES) {
      expect(a.state).toMatch(/^[A-Z]{2}$/);
      expect(a.eiaIds.length).toBeGreaterThan(0);
      for (const id of a.eiaIds) expect(Number.isInteger(id) && id > 0).toBe(true);
      const k = `${a.state}|${a.name.trim().toLowerCase()}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});

// ---------------------------------------------------------------- real data (optional)

describe.skipIf(!existsSync(path.join(process.cwd(), DEFAULT_EIA861_PATH)))("real EIA-861 data", () => {
  let real: ReturnType<typeof buildEiaIndex>;
  beforeAll(() => {
    real = buildEiaIndex(loadEia861(readFileSync(path.join(process.cwd(), DEFAULT_EIA861_PATH))));
  });
  it("every alias is present in its state", () => {
    expect(() => validateAliases(UTILITY_ALIASES, real)).not.toThrow();
  });
});

