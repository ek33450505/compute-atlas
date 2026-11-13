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
  getExpectedShape,
  getExpectedTableNames,
  runSchemaDriftCheck,
  SchemaDriftError,
  toPgIdentifier,
  type SchemaDriftReport,
} from "./check-schema-drift";

// Hand-maintained on purpose: this is the independent check proving
// getExpectedTableNames() really derives its list from the pgTable
// exports in lib/db/schema.ts. Deriving this list from that function
// instead would make the test unable to fail.
const ALL_TABLES = [
  "api_access_grants",
  "api_daily_usage",
  "commercial_checkouts",
  "contact_messages",
  "dataset_access_grants",
  "dataset_downloads",
  "dataset_editions",
  "discovery_heartbeat",
  "email_sends",
  "email_suppressions",
  "facilities",
  "facility_history",
  "intake_attempts",
  "leads",
  "maintenance_ledger",
  "operator_ownership",
  "paypal_webhook_events",
  "siting_context",
  "state_digest_runs",
  "submission_notify_requests",
  "submission_notify_sends",
  "submissions",
  "subscribe_attempts",
  "subscriptions",
].sort();

// ---------------------------------------------------------------------------
// getExpectedTableNames — pure, no database
// ---------------------------------------------------------------------------

describe("getExpectedTableNames", () => {
  it("derives every pgTable export from lib/db/schema.ts, not a hardcoded list", () => {
    expect(getExpectedTableNames()).toEqual(ALL_TABLES);
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
    expect(report.presentTables).toEqual(ALL_TABLES);
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
    expect((err as SchemaDriftError).report.presentTables).toEqual(ALL_TABLES);
  });

  it("reports no missing tables under a least-privilege role, where information_schema would hide them", async () => {
    // Isolated instance: SET ROLE must not leak into the shared one.
    const isolated = await makeTestDb();
    try {
      await isolated.client.exec(`
        CREATE ROLE ci_probe NOLOGIN;
        GRANT USAGE ON SCHEMA public TO ci_probe;
        GRANT SELECT ON api_daily_usage TO ci_probe;
        SET ROLE ci_probe;
      `);

      // The old bug: information_schema lists only tables the role can touch.
      const legacy = await isolated.client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      );
      expect(legacy.rows.length).toBeLessThan(ALL_TABLES.length);

      vi.mocked(dbClient.getDb).mockReturnValueOnce(isolated.db as never);
      const report = await runSchemaDriftCheck();
      expect(report.missingTables).toEqual([]);
      expect(report.presentTables).toEqual(ALL_TABLES);
    } finally {
      await isolated.client.close();
    }
  });

  it("throws SchemaDriftError when a table the code expects is dropped from the live database — reproduces the PR #222 incident directly", async () => {
    // Use a dedicated PGlite instance for this test only: dropping a table
    // is not something tdb.reset()'s TRUNCATE can undo, and every other test
    // in this file depends on the shared instance keeping every table.
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

  // -------------------------------------------------------------------------
  // Column / index / nullability drift (A-OPS-11). Each uses an isolated
  // PGlite because DDL cannot be undone by tdb.reset().
  // -------------------------------------------------------------------------

  async function driftAfter(ddl: string): Promise<SchemaDriftError | SchemaDriftReport> {
    const isolated = await makeTestDb();
    try {
      await isolated.client.exec(ddl);
      vi.mocked(dbClient.getDb).mockReturnValueOnce(isolated.db as never);
      return await runSchemaDriftCheck().catch((e: unknown) => e as SchemaDriftError);
    } finally {
      await isolated.client.close();
    }
  }

  it("derives expected columns and named indexes from the schema", () => {
    const shape = getExpectedShape();
    expect(shape.columns.map((c) => c.key)).toContain("dataset_access_grants.tier");
    expect(shape.indexes.map((i) => i.name)).toContain("dataset_access_grants_status_idx");
  });

  it("passes with empty missing lists on a database built from the real migrations", async () => {
    const report = await runSchemaDriftCheck();
    expect(report.missingColumns).toEqual([]);
    expect(report.nullabilityMismatches).toEqual([]);
    expect(report.missingIndexes).toEqual([]);
  });

  it("fails naming a dropped column", async () => {
    const err = await driftAfter(`ALTER TABLE "dataset_access_grants" DROP COLUMN "tier" CASCADE`);
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect((err as SchemaDriftError).report.missingColumns).toEqual(["dataset_access_grants.tier"]);
    expect((err as SchemaDriftError).message).toContain("dataset_access_grants.tier");
  });

  it("fails naming a dropped index", async () => {
    const err = await driftAfter(`DROP INDEX "dataset_access_grants_status_idx"`);
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect((err as SchemaDriftError).report.missingIndexes).toEqual([
      "dataset_access_grants: dataset_access_grants_status_idx",
    ]);
    expect((err as SchemaDriftError).message).toContain("dataset_access_grants_status_idx");
  });

  it("requires hand-managed indexes: dropping one fails, and they are not info extras", async () => {
    const ok = await runSchemaDriftCheck();
    expect(ok.extraIndexes).not.toContain("subscriptions_active_target_idx");
    expect(ok.extraIndexes).not.toContain("facilities_search_vector_idx");

    for (const [table, name] of [
      ["subscriptions", "subscriptions_active_target_idx"],
      ["facilities", "facilities_search_vector_idx"],
    ]) {
      const err = await driftAfter(`DROP INDEX "${name}"`);
      expect(err).toBeInstanceOf(SchemaDriftError);
      expect((err as SchemaDriftError).report.missingIndexes).toEqual([`${table}: ${name}`]);
    }
  });

  it("covers column-level .unique() constraints under their generated name", async () => {
    expect(getExpectedShape().indexes.map((i) => i.name)).toContain(
      "commercial_checkouts_paypal_subscription_id_unique"
    );
    const ok = await runSchemaDriftCheck();
    expect(ok.extraIndexes).not.toContain("commercial_checkouts_paypal_subscription_id_unique");

    const err = await driftAfter(
      `ALTER TABLE "commercial_checkouts" DROP CONSTRAINT "commercial_checkouts_paypal_subscription_id_unique"`
    );
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect((err as SchemaDriftError).report.missingIndexes).toEqual([
      "commercial_checkouts: commercial_checkouts_paypal_subscription_id_unique",
    ]);
  });

  it("covers column-level .references() foreign keys under Drizzle's default name", async () => {
    const fkName = "dataset_downloads_grant_id_dataset_access_grants_id_fk";
    expect(getExpectedShape().foreignKeys).toContainEqual({ table: "dataset_downloads", name: fkName });
    const ok = await runSchemaDriftCheck();
    expect(ok.missingIndexes).toEqual([]);

    const err = await driftAfter(`ALTER TABLE "dataset_downloads" DROP CONSTRAINT "${fkName}"`);
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect((err as SchemaDriftError).report.missingIndexes).toEqual([`dataset_downloads: ${fkName}`]);
  });

  it("expects a foreign key over 63 bytes under its truncated, stored name", async () => {
    const stored = "commercial_checkouts_conflict_grant_id_dataset_access_grants_id";
    expect(stored).toHaveLength(63);
    const err = await driftAfter(`ALTER TABLE "commercial_checkouts" DROP CONSTRAINT "${stored}"`);
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect((err as SchemaDriftError).report.missingIndexes).toEqual([`commercial_checkouts: ${stored}`]);
  });

  it("clips identifiers on a character boundary, never mid-character", () => {
    const ascii62 = "a".repeat(62);
    expect(toPgIdentifier(`${ascii62}é`)).toBe(ascii62);
    expect(toPgIdentifier(`${ascii62}é`)).not.toContain("�");
    expect(toPgIdentifier("b".repeat(66))).toBe("b".repeat(63));
  });

  it("fails on a NOT NULL expected but nullable, and on the reverse", async () => {
    const shape = getExpectedShape();
    const notNullCol = shape.columns.find((c) => c.notNull && c.key.startsWith("api_access_grants.") && !c.key.endsWith(".id"))!;
    const nullableCol = shape.columns.find((c) => !c.notNull && c.key.startsWith("api_access_grants."))!;
    const [t1, c1] = notNullCol.key.split(".");
    const [t2, c2] = nullableCol.key.split(".");
    const err = await driftAfter(
      `ALTER TABLE "${t1}" ALTER COLUMN "${c1}" DROP NOT NULL; ` +
        `UPDATE "${t2}" SET "${c2}" = "${c2}" WHERE false; ` +
        `ALTER TABLE "${t2}" ALTER COLUMN "${c2}" SET NOT NULL;`
    );
    expect(err).toBeInstanceOf(SchemaDriftError);
    const mism = (err as SchemaDriftError).report.nullabilityMismatches;
    expect(mism.some((m) => m.startsWith(`${notNullCol.key}: expected NOT NULL, found nullable`))).toBe(true);
    expect(mism.some((m) => m.startsWith(`${nullableCol.key}: expected nullable, found NOT NULL`))).toBe(true);
  });

  it("does not double-report columns and indexes of a missing table", async () => {
    const err = await driftAfter(`DROP TABLE "api_daily_usage"`);
    const report = (err as SchemaDriftError).report;
    expect(report.missingTables).toEqual(["api_daily_usage"]);
    expect(report.missingColumns).toEqual([]);
    expect(report.missingIndexes).toEqual([]);
  });

  it("passes, reporting info only, when the DB has an extra column and an extra index", async () => {
    const result = await driftAfter(
      `ALTER TABLE "api_access_grants" ADD COLUMN "hotfix_col" text; ` +
        `CREATE INDEX "hotfix_manual_idx" ON "api_access_grants" ("hotfix_col");`
    );
    expect(result).not.toBeInstanceOf(Error);
    const report = result as SchemaDriftReport;
    expect(report.extraColumns).toContain("api_access_grants.hotfix_col");
    expect(report.extraIndexes).toContain("hotfix_manual_idx");
  });

  it("sees columns and indexes under a least-privilege role with no table grants", async () => {
    const isolated = await makeTestDb();
    try {
      await isolated.client.exec(`
        CREATE ROLE ci_probe2 NOLOGIN;
        GRANT USAGE ON SCHEMA public TO ci_probe2;
        GRANT SELECT ON api_daily_usage TO ci_probe2;
        SET ROLE ci_probe2;
      `);
      vi.mocked(dbClient.getDb).mockReturnValueOnce(isolated.db as never);
      const report = await runSchemaDriftCheck();
      expect(report.missingColumns).toEqual([]);
      expect(report.nullabilityMismatches).toEqual([]);
      expect(report.missingIndexes).toEqual([]);
    } finally {
      await isolated.client.close();
    }
  });
});
