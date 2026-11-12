// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Swaps the real Neon client for PGlite, same pattern as scripts/check-schema-drift.test.ts.
vi.mock("../../lib/db/client");

import * as dbClient from "../../lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { emailSendsTable, subscriptionsTable } from "../../lib/db/schema";
import {
  countDigestSubscriptions,
  fetchIncompleteRuns,
  fetchNewestRunSends,
} from "../discovery/check-digest-status";
import {
  CronCheckError,
  countStalePaypalEvents,
  fetchNewestDigestStart,
  fetchNewestEdition,
  fetchRecentSends,
  runChecks,
} from "./check-cron-freshness";
import { GRANTED_COLUMNS, ROLE, buildPlan, columnGrantStatements, verifyRole, type Sql } from "./create-ci-monitor-role";

let tdb: TestDbHandle;

const asOwner = async <T>(fn: () => Promise<T>): Promise<T> => {
  await tdb.client.exec("RESET ROLE");
  try {
    return await fn();
  } finally {
    await tdb.client.exec(`SET ROLE ${ROLE}`);
  }
};

/** PGlite returns {rows}; verifyRole expects Neon's plain row array. */
const neonShaped = (): Sql => ({ query: async (text) => (await tdb.client.query(text)).rows });

const allColumns = Object.entries(GRANTED_COLUMNS).flatMap(([t, cs]) => cs.map((c) => [t, c] as const));
const columnPrivs = async (): Promise<boolean[]> =>
  Promise.all(
    allColumns.map(async ([t, c]) => {
      const r = await tdb.client.query<{ p: boolean }>(
        `SELECT has_column_privilege('${ROLE}', '${t}', '${c}', 'SELECT') AS p`
      );
      return r.rows[0].p;
    })
  );

const tableCount = async (): Promise<number> =>
  (await tdb.client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = 'public'")).rows[0].n;

const SAFE_PW = "A".repeat(40);

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  await tdb.client.exec(`
    INSERT INTO subscriptions (email, target_type, target_id, status, confirm_token, unsubscribe_token)
      VALUES ('secret@example.com', 'state', 'OH', 'confirmed', 'c', 'u');
    INSERT INTO state_digest_runs (since, until) VALUES (now() - interval '40 days', now() - interval '33 days');
    INSERT INTO email_sends (kind, email_hash, outcome) VALUES ('state_digest', 'h', 'sent');
    INSERT INTO paypal_webhook_events (id, event_type) VALUES ('WH-1', 'X');
    INSERT INTO dataset_editions (edition_date, status) VALUES ('2026-11-06', 'published');
    CREATE ROLE ${ROLE} NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${ROLE};
  `);
});

afterAll(async () => {
  await tdb.client.exec("RESET ROLE");
});

describe("REVOKE ALL ON ALL TABLES also clears column-level grants", () => {
  it("every granted column is readable after GRANT and unreadable after the role script's REVOKE", async () => {
    await tdb.client.exec(columnGrantStatements().join(";\n"));
    expect((await columnPrivs()).every(Boolean)).toBe(true);
    const revoke = buildPlan('"d"', "<redacted>", true).find((s) => s.startsWith("REVOKE ALL ON ALL TABLES"));
    expect(revoke).toBeDefined();
    await tdb.client.exec(revoke as string);
    expect((await columnPrivs()).some(Boolean)).toBe(false);
  });
});

describe("ci_monitor as the real role script builds it", () => {
  beforeAll(async () => {
    const q = await tdb.client.query<{ q: string }>("SELECT quote_ident(current_database()) AS q");
    for (const stmt of buildPlan(q.rows[0].q, SAFE_PW, true)) await tdb.client.exec(stmt);
    await tdb.client.exec(`SET ROLE ${ROLE}`);
  });

  it("passes the real verifyRole", async () => {
    const res = await verifyRole(neonShaped(), await tableCount());
    expect(res.filter((r) => !r.ok).map((r) => r.name)).toEqual([]);
    expect(res.length).toBeGreaterThan(10);
  });

  it("verifyRole fails on a stray table-level GRANT SELECT ON subscriptions", async () => {
    await asOwner(() => tdb.client.exec(`GRANT SELECT ON subscriptions TO ${ROLE}`));
    const res = await verifyRole(neonShaped(), await tableCount());
    expect(res.find((r) => r.name.startsWith("no table-level"))?.ok).toBe(false);
    expect(res.find((r) => r.name.startsWith("column-readable"))?.ok).toBe(false);
    await asOwner(() => tdb.client.exec(`REVOKE SELECT ON subscriptions FROM ${ROLE}`));
    // REVOKE at table level also took the column grants; restore the plan's column grants.
    await asOwner(() => tdb.client.exec(columnGrantStatements().join(";\n")));
    const res2 = await verifyRole(neonShaped(), await tableCount());
    expect(res2.filter((r) => !r.ok).map((r) => r.name)).toEqual([]);
  });

  it("lets every check-cron-freshness query run", async () => {
    await expect(fetchNewestDigestStart()).resolves.toBeInstanceOf(Date);
    await expect(fetchNewestEdition()).resolves.toMatchObject({ status: "published" });
    await expect(countStalePaypalEvents(new Date(Date.now() + 1000))).resolves.toBe(1);
    await expect(fetchRecentSends(new Date(0))).resolves.toHaveLength(1);
  });

  it("lets every check-digest-status query run", async () => {
    await expect(fetchIncompleteRuns()).resolves.toHaveLength(1);
    await expect(fetchNewestRunSends()).resolves.toMatchObject({ rows: [] });
    await expect(countDigestSubscriptions()).resolves.toBe(1);
  });

  it("denies reading subscriptions.email, and select *", async () => {
    await expect(tdb.client.query("SELECT email FROM subscriptions")).rejects.toMatchObject({ code: "42501" });
    await expect(tdb.client.query("SELECT * FROM subscriptions")).rejects.toMatchObject({ code: "42501" });
    await expect(tdb.db.select({ email: subscriptionsTable.email }).from(subscriptionsTable)).rejects.toThrow();
  });

  it("denies the ungranted columns of the other column-granted tables", async () => {
    await expect(tdb.client.query("SELECT resend_id FROM email_sends")).rejects.toMatchObject({ code: "42501" });
    await expect(tdb.client.query("SELECT id FROM paypal_webhook_events")).rejects.toMatchObject({ code: "42501" });
    await expect(tdb.client.query("SELECT grant_id FROM paypal_webhook_events")).rejects.toMatchObject({ code: "42501" });
    await expect(tdb.client.query("SELECT files FROM dataset_editions")).rejects.toMatchObject({ code: "42501" });
  });

  it("mutation: a query widened by one ungranted column fails under the role", async () => {
    await expect(
      tdb.db.select({ id: emailSendsTable.id, resendId: emailSendsTable.resendId }).from(emailSendsTable)
    ).rejects.toThrow();
  });

  describe("fetcher error paths", () => {
    it("a query error becomes a CronCheckError carrying only the SQLSTATE", async () => {
      await asOwner(() => tdb.client.exec(`REVOKE SELECT (kind) ON email_sends FROM ${ROLE}`));
      try {
        const err = await fetchRecentSends(new Date(0)).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CronCheckError);
        expect((err as Error).message).toBe("Failed to query email_sends: 42501");
        const report = await runChecks({
          fetchNewestDigestStart,
          fetchNewestEdition,
          countStalePaypalEvents,
          fetchRecentSends,
          datasetSharingEnabled: true,
          now: () => new Date(),
        });
        expect(report.failures).toContain("Failed to query email_sends: 42501");
      } finally {
        await asOwner(() => tdb.client.exec(`GRANT SELECT (kind) ON email_sends TO ${ROLE}`));
      }
    });

    it("digest-start and edition query errors carry only the SQLSTATE", async () => {
      await asOwner(() => tdb.client.exec(`REVOKE SELECT (built_at) ON dataset_editions FROM ${ROLE}; REVOKE SELECT ON state_digest_runs FROM ${ROLE}`));
      try {
        await expect(fetchNewestEdition()).rejects.toThrow(new CronCheckError("Failed to query dataset_editions: 42501"));
        await expect(fetchNewestDigestStart()).rejects.toThrow(new CronCheckError("Failed to query state_digest_runs: 42501"));
      } finally {
        await asOwner(() => tdb.client.exec(`GRANT SELECT (built_at) ON dataset_editions TO ${ROLE}; GRANT SELECT ON state_digest_runs TO ${ROLE}`));
      }
    });

    it.each([
      ["state_digest_runs", () => fetchNewestDigestStart()],
      ["paypal_webhook_events", () => countStalePaypalEvents(new Date())],
      ["email_sends", () => fetchRecentSends(new Date(0))],
    ])("a missing %s table gives null (a note), not a throw", async (table, fn) => {
      await asOwner(() => tdb.client.exec(`ALTER TABLE ${table} RENAME TO ${table}_gone`));
      try {
        await expect(fn()).resolves.toBeNull();
      } finally {
        await asOwner(() => tdb.client.exec(`ALTER TABLE ${table}_gone RENAME TO ${table}`));
      }
    });

    it("a missing dataset_editions table gives null, which the flag-on check fails", async () => {
      await asOwner(() => tdb.client.exec("ALTER TABLE dataset_editions RENAME TO dataset_editions_gone"));
      try {
        await expect(fetchNewestEdition()).resolves.toBeNull();
      } finally {
        await asOwner(() => tdb.client.exec("ALTER TABLE dataset_editions_gone RENAME TO dataset_editions"));
      }
    });
  });
});
