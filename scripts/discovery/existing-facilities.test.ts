/**
 * Tests for projectExisting() — the compact per-state facility projection
 * injected into the discovery prompt as {{EXISTING_FACILITIES}} — plus its
 * missing-enrichable-families column and the dead-sources block helpers
 * (loadLatestSourceHealth / projectDeadSources).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, afterEach } from "vitest";

import type { Facility } from "../../lib/schema";
import type { SourceCheckResult, SourceHealthReport } from "./check-sources";
import { loadLatestSourceHealth, projectDeadSources, projectExisting } from "./existing-facilities";

/** Every family missingEnrichableFamilies() reports for a bare makeFacility() default. */
const ALL_MISSING = "capacityMw,energy,water,address,investmentUsd,landAcres,aiClassification,jobs,community,subsidies";

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "acme-dc-1",
    name: "Acme Data Center 1",
    operator: "Acme Corp",
    status: "proposed",
    confidence: "reported",
    facilityType: "data_center",
    location: {
      lat: 30.2672,
      lon: -97.7431,
      state: "TX",
      precision: "exact",
    },
    statusHistory: [{ status: "proposed", date: "2026-01-01" }],
    sources: [
      {
        url: "https://example.com/acme-announcement",
        label: "Announcement",
        retrievedAt: "2026-01-01",
        kind: "press",
      },
    ],
    lastUpdated: "2026-01-01",
    ...overrides,
  } as Facility;
}

describe("projectExisting", () => {
  it("filters facilities by location.state", () => {
    const tx = makeFacility({ id: "tx-one" });
    const va = makeFacility({
      id: "va-one",
      location: { lat: 38.9, lon: -77.4, state: "VA", precision: "exact" },
    });
    const result = projectExisting([tx, va], "TX");
    expect(result).toContain("tx-one");
    expect(result).not.toContain("va-one");
  });

  it("renders one compact pipe-delimited line per facility", () => {
    const facility = makeFacility();
    const result = projectExisting([facility], "TX");
    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      `acme-dc-1 | Acme Data Center 1 | Acme Corp | proposed | 2026-01-01 | https://example.com/acme-announcement | missing:${ALL_MISSING}`
    );
  });

  it("uses the latest statusHistory date, not the first", () => {
    const facility = makeFacility({
      statusHistory: [
        { status: "proposed", date: "2026-01-01" },
        { status: "under_construction", date: "2026-03-15" },
      ],
    });
    const result = projectExisting([facility], "TX");
    expect(result).toContain("2026-03-15");
    expect(result).not.toContain("2026-01-01");
  });

  it("falls back to lastUpdated when statusHistory is empty", () => {
    const facility = makeFacility({ statusHistory: [], lastUpdated: "2026-05-20" });
    const result = projectExisting([facility], "TX");
    expect(result).toContain("2026-05-20");
  });

  it("falls back to lastUpdated when statusHistory is undefined", () => {
    const facility = makeFacility({ statusHistory: undefined, lastUpdated: "2026-06-11" });
    const result = projectExisting([facility], "TX");
    expect(result).toContain("2026-06-11");
  });

  it("uses the first source URL when multiple sources are present", () => {
    const facility = makeFacility({
      sources: [
        {
          url: "https://example.com/first",
          label: "First",
          retrievedAt: "2026-01-01",
          kind: "press",
        },
        {
          url: "https://example.com/second",
          label: "Second",
          retrievedAt: "2026-02-01",
          kind: "press",
        },
      ],
    });
    const result = projectExisting([facility], "TX");
    expect(result).toContain("https://example.com/first");
    expect(result).not.toContain("https://example.com/second");
  });

  it("returns an empty string for a state with zero facilities", () => {
    const facility = makeFacility();
    const result = projectExisting([facility], "OH");
    expect(result).toBe("");
  });

  it("returns an empty string for an empty facilities array", () => {
    const result = projectExisting([], "TX");
    expect(result).toBe("");
  });

  it("renders one line per facility, newline-separated, for multiple matches", () => {
    const a = makeFacility({ id: "tx-a", name: "A" });
    const b = makeFacility({ id: "tx-b", name: "B" });
    const result = projectExisting([a, b], "TX");
    const lines = result.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("tx-a");
    expect(lines[1]).toContain("tx-b");
  });

  it("neutralizes an embedded '|' and embedded newline so the row stays exactly one line", () => {
    const facility = makeFacility({
      id: "tx-injected",
      name: "Foo | Bar",
      operator: "Acme\nEvil Corp",
    });
    const other = makeFacility({ id: "tx-normal", name: "Normal Co" });
    const result = projectExisting([facility, other], "TX");
    const lines = result.trim().split("\n");

    // Exactly 2 rows total — the injected `|`/newline must not have produced
    // extra lines or extra columns.
    expect(lines).toHaveLength(2);

    const injectedLine = lines.find((line) => line.includes("tx-injected"));
    expect(injectedLine).toBeDefined();
    // The row still has exactly 7 fields (6 internal " | " delimiters) —
    // the injected pipe was neutralized, not left as an 8th column.
    expect(injectedLine!.split(" | ")).toHaveLength(7);
    expect(injectedLine).toContain("Foo / Bar");
    expect(injectedLine).toContain("Acme Evil Corp");

    const normalLine = lines.find((line) => line.includes("tx-normal"));
    expect(normalLine).toBe(
      `tx-normal | Normal Co | Acme Corp | proposed | 2026-01-01 | https://example.com/acme-announcement | missing:${ALL_MISSING}`
    );
  });

  it("leaves a normal facility's fields unchanged", () => {
    const facility = makeFacility();
    const result = projectExisting([facility], "TX");
    expect(result).toBe(
      `acme-dc-1 | Acme Data Center 1 | Acme Corp | proposed | 2026-01-01 | https://example.com/acme-announcement | missing:${ALL_MISSING}`
    );
  });

  it("still returns an empty string for the no-match case with sanitization applied", () => {
    const facility = makeFacility({ name: "Foo | Bar" });
    const result = projectExisting([facility], "OH");
    expect(result).toBe("");
  });

  it("appends a missing: token listing missing enrichable families", () => {
    const facility = makeFacility({
      capacityMw: { planned: 100, operational: 50 },
      energy: { source: "grid", utility: "Dominion", onSiteGenerationMw: 5 },
      location: { lat: 30.2672, lon: -97.7431, state: "TX", precision: "exact" },
    });
    const result = projectExisting([facility], "TX");
    expect(result).toContain("missing:");
    expect(result).not.toContain("capacityMw");
    expect(result).not.toContain(",energy");
    expect(result).toContain("water");
    expect(result).toContain("address");
  });

  it("emits missing:none for a fully-populated facility", () => {
    const facility = makeFacility({
      capacityMw: { planned: 100, operational: 50 },
      energy: { source: "grid", utility: "Dominion", onSiteGenerationMw: 5 },
      water: { coolingType: "air", reportedMgd: 1 },
      location: {
        lat: 30.2672,
        lon: -97.7431,
        state: "TX",
        precision: "exact",
        street: "100 Main St",
        postalCode: "78701",
      },
      investmentUsd: 1_000_000,
      landAcres: 10,
      aiClassification: "confirmed",
      jobs: { construction: 100, permanent: 20, sourceIndex: 0 },
      community: { status: "supported", sourceIndex: 0 },
      subsidies: [{ program: "Enterprise Zone", amountUsd: 1000, sourceIndex: 0 }],
    });
    const result = projectExisting([facility], "TX");
    expect(result).toContain("missing:none");
  });
});

describe("projectDeadSources", () => {
  const txDead = makeFacility({ id: "tx-dead", location: { lat: 30, lon: -97, state: "TX", precision: "exact" } });
  const txAlive = makeFacility({ id: "tx-alive", location: { lat: 30, lon: -97, state: "TX", precision: "exact" } });
  const vaDead = makeFacility({ id: "va-dead", location: { lat: 38, lon: -77, state: "VA", precision: "exact" } });

  function makeReport(overrides: Partial<SourceHealthReport> = {}): SourceHealthReport {
    return {
      generatedAt: "2026-07-30T00:00:00.000Z",
      summary: {
        ok: 0,
        redirected: 0,
        gone: 0,
        bot_blocked: 0,
        throttled: 0,
        server_error: 0,
        client_error: 0,
        timeout: 0,
        error: 0,
        blocked: 0,
        total: 0,
      },
      results: [],
      ...overrides,
    };
  }

  it("returns only gone sources for facilities in the target state", () => {
    const report = makeReport({
      results: [
        {
          facilityId: "tx-dead",
          facilityName: "TX Dead",
          url: "https://example.com/tx-dead",
          sourceIndex: 0,
          httpStatus: 404,
          classification: "gone",
          checkedAt: "2026-07-30T00:00:00.000Z",
        },
        {
          facilityId: "tx-alive",
          facilityName: "TX Alive",
          url: "https://example.com/tx-alive",
          sourceIndex: 0,
          httpStatus: 200,
          classification: "ok",
          checkedAt: "2026-07-30T00:00:00.000Z",
        },
        {
          facilityId: "va-dead",
          facilityName: "VA Dead",
          url: "https://example.com/va-dead",
          sourceIndex: 0,
          httpStatus: 410,
          classification: "gone",
          checkedAt: "2026-07-30T00:00:00.000Z",
        },
      ],
    });
    const result = projectDeadSources([txDead, txAlive, vaDead], "TX", report);
    expect(result).toBe("tx-dead | https://example.com/tx-dead");
  });

  it("returns an empty string when the report has no gone entries for the state", () => {
    const report = makeReport({
      results: [
        {
          facilityId: "tx-alive",
          facilityName: "TX Alive",
          url: "https://example.com/tx-alive",
          sourceIndex: 0,
          httpStatus: 200,
          classification: "ok",
          checkedAt: "2026-07-30T00:00:00.000Z",
        },
      ],
    });
    const result = projectDeadSources([txAlive], "TX", report);
    expect(result).toBe("");
  });

  it("returns an empty string when the report is null", () => {
    const result = projectDeadSources([txDead], "TX", null);
    expect(result).toBe("");
  });

  it("returns an empty string, not a throw, when report.results is not an array (defensive guard)", () => {
    // Simulates a caller passing a malformed/legacy report that slipped past
    // loadLatestSourceHealth's own shape check — belt-and-suspenders so
    // projectDeadSources is safe regardless of caller.
    const malformed = { generatedAt: "2026-07-30T00:00:00.000Z" } as unknown as SourceHealthReport;
    const result = projectDeadSources([txDead], "TX", malformed);
    expect(result).toBe("");
  });
});

describe("loadLatestSourceHealth", () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the newest report by lexicographically-greatest filename", () => {
    dir = mkdtempSync(path.join(tmpdir(), "existing-facilities-test-"));
    const older: SourceHealthReport = {
      generatedAt: "2026-07-29T00:00:00.000Z",
      summary: {
        ok: 1,
        redirected: 0,
        gone: 0,
        bot_blocked: 0,
        throttled: 0,
        server_error: 0,
        client_error: 0,
        timeout: 0,
        error: 0,
        blocked: 0,
        total: 1,
      },
      results: [],
    };
    const newer: SourceHealthReport = { ...older, generatedAt: "2026-07-30T00:00:00.000Z" };
    writeFileSync(path.join(dir, "source-health-2026-07-29T00-00-00-000Z.json"), JSON.stringify(older));
    writeFileSync(path.join(dir, "source-health-2026-07-30T00-00-00-000Z.json"), JSON.stringify(newer));

    const result = loadLatestSourceHealth(dir);
    expect(result?.generatedAt).toBe("2026-07-30T00:00:00.000Z");
  });

  it("returns null for a missing directory", () => {
    const result = loadLatestSourceHealth(path.join(tmpdir(), "existing-facilities-test-does-not-exist"));
    expect(result).toBeNull();
  });

  it("returns null (fail-open) for an unparseable report file", () => {
    dir = mkdtempSync(path.join(tmpdir(), "existing-facilities-test-"));
    writeFileSync(path.join(dir, "source-health-2026-07-30T00-00-00-000Z.json"), "{ not valid json");

    const result = loadLatestSourceHealth(dir);
    expect(result).toBeNull();
  });

  it("returns null (fail-open) for a legacy bare-array report (pre-envelope shape)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "existing-facilities-test-"));
    const legacyResults: SourceCheckResult[] = [
      {
        facilityId: "tx-dead",
        facilityName: "TX Dead",
        url: "https://example.com/tx-dead",
        sourceIndex: 0,
        httpStatus: 404,
        classification: "gone",
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    ];
    writeFileSync(
      path.join(dir, "source-health-2026-07-30T21-34-44-199Z.json"),
      JSON.stringify(legacyResults)
    );

    const result = loadLatestSourceHealth(dir);
    expect(result).toBeNull();
  });

  it("returns null (fail-open) for a parsed non-object (e.g. a JSON string)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "existing-facilities-test-"));
    writeFileSync(path.join(dir, "source-health-2026-07-30T00-00-00-000Z.json"), JSON.stringify("not a report"));

    const result = loadLatestSourceHealth(dir);
    expect(result).toBeNull();
  });
});
