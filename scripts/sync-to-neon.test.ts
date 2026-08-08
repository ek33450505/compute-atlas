// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hoisted above the imports by Vitest — swaps the real Neon client for the
// PGlite instance below, so applySync()'s internal getDb() resolves to it.
// Same pattern as scripts/seed.test.ts.
vi.mock("../lib/db/client");

import * as dbClient from "../lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { facilitiesTable, facilityHistoryTable } from "../lib/db/schema";
import type { DataCenterFacility, PowerGenerationFacility, Source } from "../lib/schema";
import { MAX_TAGS_PER_REQUEST } from "../lib/cache-tags";

import {
  planSync,
  applySync,
  bustTags,
  readBasis,
  parseCliArgs,
  tagsForChanges,
  BASIS_CLOCK_SKEW_MARGIN_MS,
  SYNC_HISTORY_SOURCE,
  type NeonSnapshotRow,
} from "./sync-to-neon";

const OLD = new Date("2026-01-01T00:00:00.000Z");
const BASIS = new Date("2026-02-01T00:00:00.000Z");
const NEWER = new Date("2026-03-01T00:00:00.000Z");

function makeSource(label: string): Source {
  return {
    url: `https://example.com/${label}`,
    label,
    retrievedAt: "2026-01-01",
    kind: "other" as const,
  };
}

function makeDoc(overrides: Partial<DataCenterFacility> & { id: string }): DataCenterFacility {
  return {
    name: "Test Facility",
    operator: "Test Operator",
    facilityType: "data_center",
    status: "under_construction",
    confidence: "confirmed",
    location: { lat: 33.4, lon: -84.4, state: "GA", precision: "exact" },
    statusHistory: [],
    sources: [makeSource("s0")],
    lastUpdated: "2025-06-01",
    ...overrides,
  };
}

function makePowerDoc(id: string): PowerGenerationFacility {
  return {
    id,
    name: "Test Plant",
    operator: "Test Utility",
    facilityType: "power_generation",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 34.0, lon: -83.0, state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [makeSource("s0")],
    lastUpdated: "2026-01-01",
  };
}

function row(doc: DataCenterFacility | PowerGenerationFacility, updatedAt = OLD): NeonSnapshotRow {
  return { id: doc.id, doc, updatedAt };
}

// ---------------------------------------------------------------------------
// planSync — pure, no database
// ---------------------------------------------------------------------------

describe("planSync", () => {
  it("plans an id absent from Neon as a create", () => {
    const doc = makeDoc({ id: "brand-new" });

    const plan = planSync([doc], [], { basis: BASIS });

    expect(plan.creates.map((c) => c.id)).toEqual(["brand-new"]);
    expect(plan.updates).toHaveLength(0);
    expect(plan.unchangedCount).toBe(0);
  });

  it("plans a content-different row as an update, listing the changed top-level keys", () => {
    const before = makeDoc({ id: "edited", name: "Old Name" });
    const after = makeDoc({ id: "edited", name: "New Name", status: "operational" });

    const plan = planSync([after], [row(before)], { basis: BASIS });

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].changedKeys).toEqual(["name", "status"]);
    expect(plan.updates[0].prevDoc).toEqual(before);
    expect(plan.creates).toHaveLength(0);
  });

  it("counts an identical record as unchanged and writes nothing for it", () => {
    const doc = makeDoc({ id: "same" });

    const plan = planSync([doc], [row(doc)], { basis: BASIS });

    expect(plan.unchangedCount).toBe(1);
    expect(plan.creates).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    expect(plan.tags).toEqual([]);
  });

  it("treats a key-order-only difference as unchanged — jsonb round-tripping is not an edit", () => {
    const doc = makeDoc({ id: "reordered" });
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(doc).reverse()))
    ) as DataCenterFacility;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(doc));

    const plan = planSync([doc], [row(reordered)], { basis: BASIS });

    expect(plan.unchangedCount).toBe(1);
    expect(plan.updates).toHaveLength(0);
  });

  it("reports an id present only in Neon as an orphan and never touches it", () => {
    const neonOnly = makeDoc({ id: "prod-only" });
    const jsonDoc = makeDoc({ id: "in-json" });

    const plan = planSync([jsonDoc], [row(neonOnly)], { basis: BASIS });

    expect(plan.orphans).toEqual(["prod-only"]);
    expect(plan.creates.map((c) => c.id)).toEqual(["in-json"]);
    expect(plan.updates).toHaveLength(0);
  });

  it("throws on a duplicate id rather than letting the last copy silently win", () => {
    const doc = makeDoc({ id: "dupe" });

    expect(() => planSync([doc, { ...doc, name: "Other" }], [], { basis: BASIS })).toThrow(
      /Duplicate facility id/
    );
  });

  describe("drift guard", () => {
    it("blocks an update whose Neon row was written after the basis", () => {
      const before = makeDoc({ id: "approved-on-prod", name: "Old" });
      const after = makeDoc({ id: "approved-on-prod", name: "New" });

      const plan = planSync([after], [row(before, NEWER)], { basis: BASIS });

      expect(plan.updates).toHaveLength(0);
      expect(plan.blocked).toHaveLength(1);
      expect(plan.blocked[0]).toMatchObject({ id: "approved-on-prod", reason: "neon-newer" });
      expect(plan.blocked[0].changedKeys).toEqual(["name"]);
    });

    it("does NOT block an unchanged row even when Neon is newer — there is nothing to clobber", () => {
      const doc = makeDoc({ id: "same-but-newer" });

      const plan = planSync([doc], [row(doc, NEWER)], { basis: BASIS });

      expect(plan.blocked).toHaveLength(0);
      expect(plan.unchangedCount).toBe(1);
    });

    it("fails closed with no basis: every update is blocked, but creates still proceed", () => {
      const before = makeDoc({ id: "edited", name: "Old" });
      const after = makeDoc({ id: "edited", name: "New" });
      const fresh = makeDoc({ id: "brand-new" });

      const plan = planSync([after, fresh], [row(before)], { basis: null });

      expect(plan.updates).toHaveLength(0);
      expect(plan.blocked[0]).toMatchObject({ id: "edited", reason: "unknown-basis" });
      expect(plan.creates.map((c) => c.id)).toEqual(["brand-new"]);
    });

    it("--force-over-drift converts a blocked row into an update and records the guard as off", () => {
      const before = makeDoc({ id: "forced", name: "Old" });
      const after = makeDoc({ id: "forced", name: "New" });

      const plan = planSync([after], [row(before, NEWER)], {
        basis: BASIS,
        forceOverDrift: true,
      });

      expect(plan.blocked).toHaveLength(0);
      expect(plan.updates.map((u) => u.id)).toEqual(["forced"]);
      expect(plan.guardEnforced).toBe(false);
    });
  });

  describe("cache tags", () => {
    it("covers each change's facility and state tag plus the aggregate tag", () => {
      const created = makeDoc({ id: "new-one" });
      const before = makeDoc({ id: "edited", name: "Old" });
      const after = makeDoc({ id: "edited", name: "New" });

      const plan = planSync([created, after], [row(before)], { basis: BASIS });

      expect(plan.tags).toEqual(
        expect.arrayContaining(["facility:new-one", "facility:edited", "state:GA", "facilities"])
      );
      expect(new Set(plan.tags).size).toBe(plan.tags.length);
    });

    it("includes the PREVIOUS state's tag when a facility moves states", () => {
      const before = makeDoc({ id: "mover" });
      const after = makeDoc({
        id: "mover",
        location: { lat: 33.4, lon: -84.4, state: "SC", precision: "exact" },
      });

      const plan = planSync([after], [row(before)], { basis: BASIS });

      expect(plan.tags).toEqual(expect.arrayContaining(["state:SC", "state:GA"]));
    });

    it("includes power-generation when a power plant is touched", () => {
      const plan = planSync([makePowerDoc("a-plant")], [], { basis: BASIS });

      expect(plan.tags).toContain("power-generation");
    });

    it("emits no tags at all — not even 'facilities' — when nothing changes", () => {
      expect(tagsForChanges([])).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// applySync — against a real Postgres (PGlite)
// ---------------------------------------------------------------------------

describe("applySync", () => {
  let tdb: TestDbHandle;

  beforeAll(async () => {
    tdb = await makeTestDb();
    vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  });

  beforeEach(async () => {
    await tdb.reset();
  });

  afterAll(async () => {
    await tdb.client.close();
  });

  /** Reads the same projection main() feeds to planSync. */
  async function snapshot(): Promise<NeonSnapshotRow[]> {
    return tdb.db
      .select({
        id: facilitiesTable.id,
        doc: facilitiesTable.doc,
        updatedAt: facilitiesTable.updatedAt,
      })
      .from(facilitiesTable);
  }

  async function setUpdatedAt(id: string, when: Date): Promise<void> {
    await tdb.db
      .update(facilitiesTable)
      .set({ updatedAt: when })
      .where(eq(facilitiesTable.id, id));
  }

  async function historyFor(id: string) {
    return tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, id));
  }

  it("inserts a create and writes exactly one 'create' audit row attributed to maintainer-sync", async () => {
    const doc = makeDoc({ id: "fresh-facility", name: "Fresh" });
    const plan = planSync([doc], await snapshot(), { basis: BASIS });

    const result = await applySync(plan);

    expect(result.created.map((c) => c.id)).toEqual(["fresh-facility"]);
    expect(result.failed).toEqual([]);
    expect(result.historyFailures).toEqual([]);

    const rows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, "fresh-facility"));
    expect(rows[0].name).toBe("Fresh");

    const history = await historyFor("fresh-facility");
    expect(history).toHaveLength(1);
    expect(history[0].changeType).toBe("create");
    expect(history[0].source).toBe(SYNC_HISTORY_SOURCE);
  });

  it("applies an update, bumps updatedAt, and writes an 'update' audit row carrying the real diff — the db:seed --force gap this tool closes", async () => {
    const before = makeDoc({ id: "corrected", name: "Old Name", status: "under_construction" });
    await seedFacility(tdb.db, before);
    await setUpdatedAt("corrected", OLD);

    const after = makeDoc({ id: "corrected", name: "New Name", status: "operational" });
    const plan = planSync([after], await snapshot(), { basis: BASIS });

    const result = await applySync(plan);

    expect(result.updated.map((u) => u.id)).toEqual(["corrected"]);
    expect(result.blockedAtApply).toEqual([]);

    const rows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, "corrected"));
    expect(rows[0].name).toBe("New Name");
    expect(rows[0].status).toBe("operational");
    expect(rows[0].doc.name).toBe("New Name");
    expect(rows[0].updatedAt.getTime()).toBeGreaterThan(OLD.getTime());

    const history = await historyFor("corrected");
    expect(history).toHaveLength(1);
    expect(history[0].changeType).toBe("update");
    expect(history[0].source).toBe(SYNC_HISTORY_SOURCE);
    expect(history[0].diff).toEqual(
      expect.arrayContaining([
        { key: "name", before: "Old Name", after: "New Name" },
        { key: "status", before: "under_construction", after: "operational" },
      ])
    );
  });

  it("skips a row that Neon changed between planning and writing, leaving it and its history untouched", async () => {
    const before = makeDoc({ id: "raced", name: "Old Name" });
    await seedFacility(tdb.db, before);
    await setUpdatedAt("raced", OLD);

    const after = makeDoc({ id: "raced", name: "New Name" });
    const plan = planSync([after], await snapshot(), { basis: BASIS });
    expect(plan.updates).toHaveLength(1);

    // Someone approves on the admin portal after the plan was computed.
    await setUpdatedAt("raced", NEWER);

    const result = await applySync(plan);

    expect(result.blockedAtApply).toEqual(["raced"]);
    expect(result.updated).toEqual([]);

    const rows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, "raced"));
    expect(rows[0].name).toBe("Old Name");
    expect(await historyFor("raced")).toHaveLength(0);
  });

  it("--force-over-drift writes through the atomic guard too", async () => {
    const before = makeDoc({ id: "forced", name: "Old Name" });
    await seedFacility(tdb.db, before);
    await setUpdatedAt("forced", NEWER);

    const after = makeDoc({ id: "forced", name: "New Name" });
    const plan = planSync([after], await snapshot(), { basis: BASIS, forceOverDrift: true });

    const result = await applySync(plan);

    expect(result.updated.map((u) => u.id)).toEqual(["forced"]);
    const rows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, "forced"));
    expect(rows[0].name).toBe("New Name");
  });

  it("reports (never silently counts) a create whose id appeared in Neon after the plan was computed", async () => {
    const doc = makeDoc({ id: "phantom", name: "From JSON" });
    const plan = planSync([doc], await snapshot(), { basis: BASIS });
    expect(plan.creates).toHaveLength(1);

    await seedFacility(tdb.db, makeDoc({ id: "phantom", name: "From Prod" }));

    const result = await applySync(plan);

    expect(result.created).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe("phantom");

    const rows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, "phantom"));
    expect(rows[0].name).toBe("From Prod");
    expect(await historyFor("phantom")).toHaveLength(0);
  });

  it("keeps going after a failed record instead of aborting the batch", async () => {
    const good = makeDoc({ id: "good-one" });
    const clash = makeDoc({ id: "clashing" });
    const plan = planSync([clash, good], await snapshot(), { basis: BASIS });

    await seedFacility(tdb.db, makeDoc({ id: "clashing", name: "Already There" }));

    const result = await applySync(plan);

    expect(result.failed.map((f) => f.id)).toEqual(["clashing"]);
    expect(result.created.map((c) => c.id)).toEqual(["good-one"]);
  });
});

// ---------------------------------------------------------------------------
// bustTags
// ---------------------------------------------------------------------------

describe("bustTags", () => {
  const config = { baseUrl: "https://example.test", token: "secret" };

  it("posts the tags to /api/revalidate with the admin bearer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await bustTags(["facilities", "state:GA"], { ...config, fetchImpl });

    expect(result.bustedTags).toEqual(["facilities", "state:GA"]);
    expect(result.failedTags).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.test/api/revalidate");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body)).toEqual({ tags: ["facilities", "state:GA"] });
  });

  it("does not double up the slash when the base URL has a trailing one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    await bustTags(["facilities"], { baseUrl: "https://example.test/", token: "t", fetchImpl });

    expect(fetchImpl.mock.calls[0][0]).toBe("https://example.test/api/revalidate");
  });

  it("batches to the route's per-request cap so a large wave is not rejected wholesale", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const tags = Array.from({ length: MAX_TAGS_PER_REQUEST + 5 }, (_, i) => `facility:f-${i}`);

    const result = await bustTags(tags, { ...config, fetchImpl });

    expect(result.batches).toBe(2);
    expect(result.bustedTags).toHaveLength(tags.length);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).tags).toHaveLength(MAX_TAGS_PER_REQUEST);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).tags).toHaveLength(5);
  });

  it("records a rejected batch's tags without stranding the remaining batches", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("Invalid tag", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const tags = Array.from({ length: MAX_TAGS_PER_REQUEST + 1 }, (_, i) => `facility:f-${i}`);

    const result = await bustTags(tags, { ...config, fetchImpl });

    expect(result.failedTags).toHaveLength(MAX_TAGS_PER_REQUEST);
    expect(result.bustedTags).toEqual([`facility:f-${MAX_TAGS_PER_REQUEST}`]);
    expect(result.errors[0]).toContain("400");
  });

  it("treats a thrown fetch as a failed batch rather than crashing the run", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await bustTags(["facilities"], { ...config, fetchImpl });

    expect(result.failedTags).toEqual(["facilities"]);
    expect(result.errors).toEqual(["ECONNREFUSED"]);
  });
});

// ---------------------------------------------------------------------------
// readBasis
// ---------------------------------------------------------------------------

describe("readBasis", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-basis-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMeta(contents: string): string {
    const file = join(dir, "facilities.meta.json");
    writeFileSync(file, contents, "utf-8");
    return file;
  }

  it("derives the guard basis from asOf, backed off by the clock-skew margin", () => {
    const asOf = "2026-08-07T08:57:23.664Z";
    const { basis, description } = readBasis(writeMeta(JSON.stringify({ asOf })));

    expect(basis?.getTime()).toBe(new Date(asOf).getTime() - BASIS_CLOCK_SKEW_MARGIN_MS);
    expect(description).toContain(asOf);
  });

  it("returns no basis (so the caller fails closed) when the file is missing", () => {
    const { basis, description } = readBasis(join(dir, "does-not-exist.json"));

    expect(basis).toBeNull();
    expect(description).toContain("unreadable");
  });

  it("returns no basis when the file is not valid JSON", () => {
    expect(readBasis(writeMeta("{ not json")).basis).toBeNull();
  });

  it("returns no basis when asOf is missing or not a date", () => {
    expect(readBasis(writeMeta(JSON.stringify({ recordCount: 3 }))).basis).toBeNull();
    expect(readBasis(writeMeta(JSON.stringify({ asOf: "not-a-date" }))).basis).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  it("defaults to a dry run with the drift guard on", () => {
    expect(parseCliArgs([])).toEqual({
      apply: false,
      forceOverDrift: false,
      skipRevalidate: false,
    });
  });

  it("reads each flag", () => {
    expect(parseCliArgs(["--apply", "--force-over-drift", "--skip-revalidate"])).toEqual({
      apply: true,
      forceOverDrift: true,
      skipRevalidate: true,
    });
  });

  it("accepts an explicit --dry-run", () => {
    expect(parseCliArgs(["--dry-run"]).apply).toBe(false);
  });

  it("rejects an unknown argument instead of silently ignoring a typo", () => {
    expect(() => parseCliArgs(["--aply"])).toThrow(/Unknown argument/);
  });
});
