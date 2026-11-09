// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import {
  DATASET_CATEGORIES,
  DATASET_DOWNLOAD_OUTCOMES,
  DATASET_EDITION_STATUSES,
  DATASET_GRANT_STATUSES,
  datasetAccessGrantsTable,
  datasetDownloadsTable,
  datasetEditionsTable,
} from "@/lib/db/schema";
import { getExpectedTableNames } from "@/scripts/check-schema-drift";

/**
 * Schema-level tests for the approved-access dataset-sharing tables
 * (drizzle/0020_dataset_sharing_tables.sql). No lib code is under test here:
 * these pin the constraints the later units rely on (token uniqueness, the
 * cascade/set-null delete rules, the FK-less last_notice_edition_id claim).
 *
 * Rollback order: see the note on datasetAccessGrantsTable in lib/db/schema.ts.
 */

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
});

beforeEach(async () => {
  await tdb.reset();
});

afterAll(async () => {
  await tdb.client.close();
});

let seq = 0;

/** Minimal valid grant row; every call gets a distinct email and verify hash. */
function grantValues(
  overrides: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}
): typeof datasetAccessGrantsTable.$inferInsert {
  seq++;
  return {
    email: `requester-${seq}@example.com`,
    name: "Test Requester",
    category: "journalist",
    intendedUse: "Reporting on local data center siting.",
    attributionAckAt: new Date(),
    termsVersion: "2026-11",
    verifyTokenHash: `verify-hash-${seq}`,
    ...overrides,
  };
}

function editionValues(overrides: Partial<typeof datasetEditionsTable.$inferInsert> = {}) {
  seq++;
  return { editionDate: `2026-11-${String(seq).padStart(2, "0")}`, ...overrides };
}

/** The Postgres SQLSTATE a failed insert raised, or undefined if it succeeded. */
async function sqlState(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "unknown";
  }
}

async function countRows(table: string): Promise<number> {
  const res = await tdb.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`);
  return res.rows[0].n;
}

const EXPECTED_COLUMNS: Record<string, Record<string, string>> = {
  dataset_access_grants: {
    id: "uuid NOT NULL",
    created_at: "timestamp with time zone NOT NULL",
    email: "text NOT NULL",
    name: "text NOT NULL",
    organization: "text NULL",
    role: "text NULL",
    category: "text NOT NULL",
    intended_use: "text NOT NULL",
    links: "jsonb NOT NULL",
    attribution_ack_at: "timestamp with time zone NOT NULL",
    terms_version: "text NOT NULL",
    status: "text NOT NULL",
    verify_token_hash: "text NOT NULL",
    verified_at: "timestamp with time zone NULL",
    access_token_hash: "text NULL",
    renew_token_hash: "text NULL",
    unsubscribe_token: "text NULL",
    approved_at: "timestamp with time zone NULL",
    reviewed_at: "timestamp with time zone NULL",
    review_note: "text NULL",
    rejection_note: "text NULL",
    revoked_at: "timestamp with time zone NULL",
    revoke_reason: "text NULL",
    expires_at: "timestamp with time zone NULL",
    renewal_reminded_at: "timestamp with time zone NULL",
    renewal_requested_at: "timestamp with time zone NULL",
    last_download_at: "timestamp with time zone NULL",
    last_notice_edition_id: "uuid NULL",
    download_count: "integer NOT NULL",
    submitter_ip_hash: "text NULL",
  },
  dataset_editions: {
    id: "uuid NOT NULL",
    edition_date: "text NOT NULL",
    built_at: "timestamp with time zone NOT NULL",
    status: "text NOT NULL",
    record_count: "integer NULL",
    files: "jsonb NOT NULL",
    changelog_summary: "jsonb NULL",
    notice_sent_at: "timestamp with time zone NULL",
  },
  dataset_downloads: {
    id: "uuid NOT NULL",
    grant_id: "uuid NOT NULL",
    edition_id: "uuid NULL",
    file: "text NOT NULL",
    created_at: "timestamp with time zone NOT NULL",
    ip_hash: "text NULL",
    outcome: "text NOT NULL",
  },
};

describe("dataset sharing tables: shape", () => {
  it.each(Object.keys(EXPECTED_COLUMNS))("%s has exactly the expected columns, types and nullability", async (table) => {
    const res = await tdb.client.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [table]
    );
    const actual = Object.fromEntries(
      res.rows.map((r) => [r.column_name, `${r.data_type} ${r.is_nullable === "YES" ? "NULL" : "NOT NULL"}`])
    );
    expect(actual).toEqual(EXPECTED_COLUMNS[table]);
  });

  it("exports the status / category / outcome vocabularies as const arrays", () => {
    expect(DATASET_GRANT_STATUSES).toEqual([
      "unverified",
      "pending_review",
      "active",
      "expired",
      "revoked",
      "rejected",
    ]);
    expect(DATASET_CATEGORIES).toEqual([
      "journalist",
      "academic",
      "nonprofit",
      "government",
      "commercial",
      "other",
    ]);
    expect(DATASET_EDITION_STATUSES).toEqual(["building", "published", "failed"]);
    expect(DATASET_DOWNLOAD_OUTCOMES).toEqual(["served", "denied_rate", "error"]);
  });

  it("uses plain text columns, not pg enums or CHECK constraints", async () => {
    const enums = await tdb.client.query(
      `SELECT a.attname FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
       WHERE a.attrelid IN ('dataset_access_grants'::regclass, 'dataset_editions'::regclass, 'dataset_downloads'::regclass)
         AND a.attnum > 0 AND t.typtype = 'e'`
    );
    expect(enums.rows).toHaveLength(0);
    const checks = await tdb.client.query(
      `SELECT conname FROM pg_constraint
       WHERE contype = 'c'
         AND (conrelid IN ('dataset_access_grants'::regclass, 'dataset_editions'::regclass, 'dataset_downloads'::regclass)
              OR contypid IN (SELECT atttypid FROM pg_attribute
                               WHERE attrelid IN ('dataset_access_grants'::regclass, 'dataset_editions'::regclass, 'dataset_downloads'::regclass)
                                 AND attnum > 0))`
    );
    expect(checks.rows).toHaveLength(0);
  });

  it("getExpectedTableNames() includes the three dataset tables", () => {
    expect(getExpectedTableNames()).toEqual(
      expect.arrayContaining(["dataset_access_grants", "dataset_downloads", "dataset_editions"])
    );
  });
});

describe("dataset_access_grants", () => {
  it("applies the documented defaults", async () => {
    const [row] = await tdb.db.insert(datasetAccessGrantsTable).values(grantValues()).returning();
    expect(row.status).toBe("unverified");
    expect(row.downloadCount).toBe(0);
    expect(row.links).toEqual([]);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    for (const col of [
      "organization",
      "role",
      "verifiedAt",
      "accessTokenHash",
      "renewTokenHash",
      "unsubscribeToken",
      "approvedAt",
      "reviewedAt",
      "reviewNote",
      "rejectionNote",
      "revokedAt",
      "revokeReason",
      "expiresAt",
      "renewalRemindedAt",
      "renewalRequestedAt",
      "lastDownloadAt",
      "lastNoticeEditionId",
      "submitterIpHash",
    ] as const) {
      expect(row[col], col).toBeNull();
    }
  });

  it("rejects a duplicate verify_token_hash", async () => {
    await tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ verifyTokenHash: "same-verify" }));
    const code = await sqlState(
      tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ verifyTokenHash: "same-verify" }))
    );
    expect(code).toBe("23505");
  });

  it.each([
    ["accessTokenHash", "access-token-hash-1"],
    ["renewTokenHash", "renew-token-hash-1"],
    ["unsubscribeToken", "unsubscribe-token-1"],
  ] as const)("%s: rejects a duplicate non-null value but permits multiple NULLs", async (column, value) => {
    // Multiple NULLs coexist (an unverified grant has no access token yet).
    await tdb.db.insert(datasetAccessGrantsTable).values(grantValues());
    await tdb.db.insert(datasetAccessGrantsTable).values(grantValues());
    expect(await countRows("dataset_access_grants")).toBe(2);

    await tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ [column]: value }));
    const code = await sqlState(
      tdb.db.insert(datasetAccessGrantsTable).values(grantValues({ [column]: value }))
    );
    expect(code).toBe("23505");
    expect(await countRows("dataset_access_grants")).toBe(3);
  });

  it("last_notice_edition_id is nullable and accepts a uuid with no matching edition (no FK)", async () => {
    const orphan = randomUUID();
    const [row] = await tdb.db
      .insert(datasetAccessGrantsTable)
      .values(grantValues({ lastNoticeEditionId: orphan }))
      .returning();
    expect(row.lastNoticeEditionId).toBe(orphan);
  });
});

describe("dataset_editions", () => {
  it("applies the documented defaults", async () => {
    const [row] = await tdb.db.insert(datasetEditionsTable).values(editionValues()).returning();
    expect(row.status).toBe("building");
    expect(row.files).toEqual([]);
    expect(row.builtAt).toBeInstanceOf(Date);
    expect(row.recordCount).toBeNull();
    expect(row.changelogSummary).toBeNull();
    expect(row.noticeSentAt).toBeNull();
  });

  it("rejects a duplicate edition_date", async () => {
    await tdb.db.insert(datasetEditionsTable).values({ editionDate: "2026-11-09" });
    const code = await sqlState(tdb.db.insert(datasetEditionsTable).values({ editionDate: "2026-11-09" }));
    expect(code).toBe("23505");
  });
});

describe("dataset_downloads", () => {
  async function seedGrantAndEdition() {
    const [grant] = await tdb.db.insert(datasetAccessGrantsTable).values(grantValues()).returning();
    const [edition] = await tdb.db.insert(datasetEditionsTable).values(editionValues()).returning();
    return { grant, edition };
  }

  it("deleting a grant cascades to its downloads and leaves other grants' downloads alone", async () => {
    const { grant, edition } = await seedGrantAndEdition();
    const [other] = await tdb.db.insert(datasetAccessGrantsTable).values(grantValues()).returning();
    await tdb.db.insert(datasetDownloadsTable).values([
      { grantId: grant.id, editionId: edition.id, file: "facilities.csv", outcome: "served" },
      { grantId: grant.id, editionId: null, file: "facilities.json", outcome: "denied_rate" },
      { grantId: other.id, editionId: edition.id, file: "facilities.csv", outcome: "served" },
    ]);
    expect(await countRows("dataset_downloads")).toBe(3);

    await tdb.client.query(`DELETE FROM dataset_access_grants WHERE id = $1`, [grant.id]);

    const left = await tdb.db.select().from(datasetDownloadsTable);
    expect(left).toHaveLength(1);
    expect(left[0].grantId).toBe(other.id);
  });

  it("deleting an edition sets edition_id to null and keeps the download row", async () => {
    const { grant, edition } = await seedGrantAndEdition();
    await tdb.db
      .insert(datasetDownloadsTable)
      .values({ grantId: grant.id, editionId: edition.id, file: "facilities.csv", outcome: "served" });

    await tdb.client.query(`DELETE FROM dataset_editions WHERE id = $1`, [edition.id]);

    const rows = await tdb.db.select().from(datasetDownloadsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].editionId).toBeNull();
    expect(rows[0].grantId).toBe(grant.id);
  });

  it("rejects a download for a grant that does not exist", async () => {
    const code = await sqlState(
      tdb.db
        .insert(datasetDownloadsTable)
        .values({ grantId: randomUUID(), file: "facilities.csv", outcome: "served" })
    );
    expect(code).toBe("23503");
  });

  it("stamps `created_at` by default and leaves ip_hash nullable", async () => {
    const { grant } = await seedGrantAndEdition();
    const [row] = await tdb.db
      .insert(datasetDownloadsTable)
      .values({ grantId: grant.id, file: "facilities.csv", outcome: "error" })
      .returning();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.ipHash).toBeNull();
    expect(row.editionId).toBeNull();
  });
});

describe("test harness reset()", () => {
  it("truncates all three dataset tables", async () => {
    const [grant] = await tdb.db.insert(datasetAccessGrantsTable).values(grantValues()).returning();
    const [edition] = await tdb.db.insert(datasetEditionsTable).values(editionValues()).returning();
    await tdb.db
      .insert(datasetDownloadsTable)
      .values({ grantId: grant.id, editionId: edition.id, file: "facilities.csv", outcome: "served" });

    await tdb.reset();

    expect(await countRows("dataset_access_grants")).toBe(0);
    expect(await countRows("dataset_editions")).toBe(0);
    expect(await countRows("dataset_downloads")).toBe(0);
  });
});
