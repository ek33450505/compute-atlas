// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports by Vitest — swaps the real Neon client for the
// PGlite instance below, so runSchemaDriftCheck()'s internal getDb() resolves
// to it. Same pattern as scripts/sync-to-neon.test.ts.
vi.mock("../lib/db/client");

import * as dbClient from "../lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { apiDailyUsageTable } from "../lib/db/schema";
import {
  getExpectedTableNames,
  runSchemaDriftCheck,
  SchemaDriftError,
} from "./check-schema-drift";

const ALL_NINE_TABLES = [
  "api_access_grants",
  "api_daily_usage",
  "contact_messages",
  "discovery_heartbeat",
  "facilities",
  "facility_history",
  "leads",
  "submissions",
  "subscriptions",
].sort();

// ---------------------------------------------------------------------------
// getExpectedTableNames — pure, no database
// ---------------------------------------------------------------------------

describe("getExpectedTableNames", () => {
  it("derives every pgTable export from lib/db/schema.ts, not a hardcoded list", () => {
    expect(getExpectedTableNames()).toEqual(ALL_NINE_TABLES);
  });
});

// ---------------------------------------------------------------------------
// runSchemaDriftCheck — against a real Postgres (PGlite)
// ---------------------------------------------------------------------------

describe("runSchemaDriftCheck", () => {
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

  it("passes with zero missing tables when every migration has been applied", async () => {
    const report = await runSchemaDriftCheck();

    expect(report.missingTables).toEqual([]);
    expect(report.presentTables).toEqual(ALL_NINE_TABLES);
  });

  it("reports a zero-row WARNING signal (not a failure) when api_daily_usage has no rows for the given day", async () => {
    const report = await runSchemaDriftCheck(getExpectedTableNames(), "2026-09-03");

    expect(report.capLiveness).toEqual({ day: "2026-09-03", rowCount: 0 });
    // Zero rows must never be treated as drift — the caller decides whether
    // to warn; the report itself does not throw for this.
    expect(report.missingTables).toEqual([]);
  });

  it("counts today's api_daily_usage rows as a liveness signal when the cap gate has been writing", async () => {
    await tdb.db.insert(apiDailyUsageTable).values([
      { ipHash: "hash-a", day: "2026-09-03", count: 3 },
      { ipHash: "hash-b", day: "2026-09-03", count: 1 },
      { ipHash: "hash-c", day: "2026-09-02", count: 9 }, // different day — must not count
    ]);

    const report = await runSchemaDriftCheck(getExpectedTableNames(), "2026-09-03");

    expect(report.capLiveness).toEqual({ day: "2026-09-03", rowCount: 2 });
  });

  // -------------------------------------------------------------------------
  // THE important one: prove the guard actually fails when a table is
  // missing. Two independent ways to induce "missing":
  //   1. inject a fake expected table name the live database can never have
  //   2. drop a REAL table (mirrors the actual PR #222 incident exactly)
  // -------------------------------------------------------------------------

  it("throws SchemaDriftError when an expected table name does not exist in the live database", async () => {
    const expectedWithFake = [...getExpectedTableNames(), "totally_fake_table_xyz"];

    await expect(runSchemaDriftCheck(expectedWithFake)).rejects.toThrow(SchemaDriftError);

    // Re-run to inspect the thrown error's attached report (reject/toThrow
    // above only proves it throws; this proves it names the right table).
    const err = await runSchemaDriftCheck(expectedWithFake).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect((err as SchemaDriftError).report.missingTables).toEqual(["totally_fake_table_xyz"]);
    expect((err as SchemaDriftError).report.presentTables).toEqual(ALL_NINE_TABLES);
  });

  it("throws SchemaDriftError when a table the code expects is dropped from the live database — reproduces the PR #222 incident directly", async () => {
    // Use a dedicated PGlite instance for this test only: dropping a table
    // is not something tdb.reset()'s TRUNCATE can undo, and every other test
    // in this file depends on the shared instance keeping all 9 tables.
    const isolated = await makeTestDb();
    try {
      await isolated.client.exec(`DROP TABLE "api_daily_usage"`);
      vi.mocked(dbClient.getDb).mockReturnValueOnce(isolated.db as never);

      await expect(runSchemaDriftCheck()).rejects.toThrow(SchemaDriftError);

      vi.mocked(dbClient.getDb).mockReturnValueOnce(isolated.db as never);
      const err = await runSchemaDriftCheck().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SchemaDriftError);
      expect((err as SchemaDriftError).report.missingTables).toEqual(["api_daily_usage"]);
    } finally {
      await isolated.client.close();
    }
  });
});
