// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { datasetAccessGrantsTable, datasetDownloadsTable, emailSendsTable } from "@/lib/db/schema";
import { hashToken } from "@/lib/token-hash";

// Imported after the mocks above so its transitive import of lib/db/client resolves against the mock.
import {
  ADMIN_DOWNLOAD_LOG_LIMIT,
  ADMIN_GRANTS_LIST_LIMIT,
  DATASET_REISSUE_COOLDOWN_MS,
  getDatasetDownloadLog,
  hasRecentLinkReissue,
  listDatasetGrantsForAdmin,
  listDatasetReviewQueue,
  toAdminGrant,
} from "@/lib/dataset-admin";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
});

afterAll(async () => {
  await tdb.client.close();
});

let seedCounter = 0;

// Each seeded grant gets its own email: the partial unique index dataset_access_grants_open_email_idx
// allows one open row (unverified / pending_review / active) per email.
async function insertGrant(over: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}) {
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: `r${seedCounter}@example.com`,
      name: "Seed",
      category: "journalist",
      intendedUse: "seed",
      attributionAckAt: new Date(),
      termsVersion: "seed-terms",
      verifyTokenHash: hashToken(`seed-verify-${seedCounter++}`),
      ...over,
    })
    .returning();
  return row;
}

const daysFromNow = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

const FORBIDDEN_KEYS = ["verifyTokenHash", "accessTokenHash", "renewTokenHash", "unsubscribeToken", "submitterIpHash", "ipHash"];

describe("listDatasetReviewQueue", () => {
  it("lists pending_review rows then renewal-pending rows, including one past its expiry", async () => {
    const renewalLate = await insertGrant({
      name: "renewal-late",
      status: "active",
      expiresAt: daysFromNow(5),
      renewalRequestedAt: daysFromNow(-1),
    });
    const renewalPastExpiry = await insertGrant({
      name: "renewal-past",
      status: "active",
      expiresAt: daysFromNow(-3),
      renewalRequestedAt: daysFromNow(-4),
    });
    const pendingNew = await insertGrant({ name: "pending-new", status: "pending_review", createdAt: daysFromNow(-1) });
    const pendingOld = await insertGrant({ name: "pending-old", status: "pending_review", createdAt: daysFromNow(-9) });

    const queue = await listDatasetReviewQueue();

    expect(queue.map((g) => g.id)).toEqual([pendingOld.id, pendingNew.id, renewalPastExpiry.id, renewalLate.id]);

    const past = queue.find((g) => g.id === renewalPastExpiry.id)!;
    expect(past.renewalPending).toBe(true);
    expect(past.live).toBe(false);

    const late = queue.find((g) => g.id === renewalLate.id)!;
    expect(late.renewalPending).toBe(true);
    expect(late.live).toBe(true);

    const pending = queue.find((g) => g.id === pendingOld.id)!;
    expect(pending.renewalPending).toBe(false);
    expect(pending.live).toBe(false);
  });

  it("excludes unverified, plain active, rejected, revoked and expired rows", async () => {
    const pending = await insertGrant({ status: "pending_review" });
    await insertGrant({ status: "unverified" });
    await insertGrant({ status: "active", expiresAt: daysFromNow(10) }); // active, no renewal request
    await insertGrant({ status: "active", expiresAt: daysFromNow(-10) }); // lapsed: past expiry, no renewal request
    await insertGrant({ status: "rejected", rejectionNote: "no" });
    await insertGrant({ status: "revoked", revokedAt: new Date(), revokeReason: "abuse" });
    await insertGrant({ status: "expired", expiresAt: daysFromNow(-20) });

    const queue = await listDatasetReviewQueue();

    expect(queue.map((g) => g.id)).toEqual([pending.id]);
  });

  it("returns an empty list when nothing awaits review", async () => {
    expect(await listDatasetReviewQueue()).toEqual([]);
  });

  it("round-trips the displayed fields, including the links array", async () => {
    const row = await insertGrant({
      status: "pending_review",
      name: "Ada",
      organization: "Org",
      role: "Reporter",
      category: "academic",
      intendedUse: "research",
      links: ["https://example.com/a", "https://example.com/b"],
      downloadCount: 3,
    });

    const [got] = await listDatasetReviewQueue();

    expect(got).toMatchObject({
      id: row.id,
      email: row.email,
      name: "Ada",
      organization: "Org",
      role: "Reporter",
      category: "academic",
      intendedUse: "research",
      links: ["https://example.com/a", "https://example.com/b"],
      status: "pending_review",
      downloadCount: 3,
    });
    expect(got.createdAt).toBeInstanceOf(Date);
  });
});

describe("listDatasetGrantsForAdmin", () => {
  it("returns only the requested status, newest first, with live computed per row", async () => {
    const older = await insertGrant({ status: "active", expiresAt: daysFromNow(-2), createdAt: daysFromNow(-8) });
    const newer = await insertGrant({ status: "active", expiresAt: daysFromNow(30), createdAt: daysFromNow(-1) });
    await insertGrant({ status: "pending_review", createdAt: daysFromNow(-3) });
    await insertGrant({ status: "rejected", createdAt: daysFromNow(-3) });

    const rows = await listDatasetGrantsForAdmin("active");

    expect(rows.map((g) => g.id)).toEqual([newer.id, older.id]);
    expect(rows.map((g) => g.status)).toEqual(["active", "active"]);
    expect(rows[0].live).toBe(true);
    expect(rows[1].live).toBe(false);
    expect(rows[0].renewalPending).toBe(false);
  });

  it("honours the `now` argument when computing live", async () => {
    await insertGrant({ status: "active", expiresAt: daysFromNow(5) });

    const [now] = await listDatasetGrantsForAdmin("active");
    const [later] = await listDatasetGrantsForAdmin("active", daysFromNow(10));

    expect(now.live).toBe(true);
    expect(later.live).toBe(false);
  });

  it(`caps the list at ${ADMIN_GRANTS_LIST_LIMIT} rows`, async () => {
    // `rejected` is not an open status, so the one-open-row-per-email index does not bite.
    const base = Date.now();
    const rows = Array.from({ length: ADMIN_GRANTS_LIST_LIMIT + 1 }, (_, i) => ({
      email: `bulk${i}@example.com`,
      name: `Bulk ${i}`,
      category: "other" as const,
      intendedUse: "bulk",
      attributionAckAt: new Date(),
      termsVersion: "seed-terms",
      verifyTokenHash: hashToken(`bulk-verify-${i}`),
      status: "rejected" as const,
      createdAt: new Date(base - i * 1000), // i = 0 is the newest
    }));
    await tdb.db.insert(datasetAccessGrantsTable).values(rows);

    const got = await listDatasetGrantsForAdmin("rejected");

    expect(got).toHaveLength(ADMIN_GRANTS_LIST_LIMIT);
    expect(got[0].name).toBe("Bulk 0");
    expect(got.map((g) => g.name)).not.toContain(`Bulk ${ADMIN_GRANTS_LIST_LIMIT}`); // the oldest is the one dropped
  });
});

describe("projection guard", () => {
  it("never exposes a secret or IP-hash column from any list function", async () => {
    const secrets = {
      verifyTokenHash: "SECRET-VERIFY-HASH-aaaa",
      accessTokenHash: "SECRET-ACCESS-HASH-bbbb",
      renewTokenHash: "SECRET-RENEW-HASH-cccc",
      unsubscribeToken: "SECRET-UNSUB-TOKEN-dddd",
      submitterIpHash: "SECRET-SUBMITTER-IP-eeee",
    };
    let i = 0;
    const seeded = async (over: Partial<typeof datasetAccessGrantsTable.$inferInsert>) => {
      const n = i++;
      return insertGrant({
        verifyTokenHash: `${secrets.verifyTokenHash}-${n}`,
        accessTokenHash: `${secrets.accessTokenHash}-${n}`,
        renewTokenHash: `${secrets.renewTokenHash}-${n}`,
        unsubscribeToken: `${secrets.unsubscribeToken}-${n}`,
        submitterIpHash: `${secrets.submitterIpHash}-${n}`,
        ...over,
      });
    };
    await seeded({ status: "pending_review" });
    await seeded({ status: "active", expiresAt: daysFromNow(10), renewalRequestedAt: new Date() });
    await seeded({ status: "active", expiresAt: daysFromNow(10) });

    const queue = await listDatasetReviewQueue();
    const active = await listDatasetGrantsForAdmin("active");
    const pending = await listDatasetGrantsForAdmin("pending_review");
    const log = await getDatasetDownloadLog(active[0].id);

    const all = [...queue, ...active, ...pending];
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      for (const key of FORBIDDEN_KEYS) expect(Object.keys(row)).not.toContain(key);
    }
    for (const key of FORBIDDEN_KEYS) expect(Object.keys(log!.grant)).not.toContain(key);

    const serialized = JSON.stringify({ queue, active, pending, log });
    expect(serialized).not.toContain("SECRET-");
  });

  it("never exposes ipHash from the download log", async () => {
    const grant = await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
    await tdb.db.insert(datasetDownloadsTable).values({
      grantId: grant.id,
      file: "facilities.csv",
      outcome: "served",
      ipHash: "SECRET-DOWNLOAD-IP-ffff",
    });

    const log = await getDatasetDownloadLog(grant.id);

    expect(log!.downloads).toHaveLength(1);
    for (const key of FORBIDDEN_KEYS) expect(Object.keys(log!.downloads[0])).not.toContain(key);
    expect(JSON.stringify(log)).not.toContain("SECRET-");
  });
});

describe("getDatasetDownloadLog", () => {
  it(`returns the newest ${ADMIN_DOWNLOAD_LOG_LIMIT} downloads of that grant only, with the grant's totals`, async () => {
    const grant = await insertGrant({
      status: "active",
      expiresAt: daysFromNow(10),
      name: "Log Subject",
      downloadCount: 55,
      lastDownloadAt: daysFromNow(-1),
    });
    const other = await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
    const base = Date.now();
    await tdb.db.insert(datasetDownloadsTable).values(
      Array.from({ length: 55 }, (_, i) => ({
        grantId: grant.id,
        file: `file-${i}.csv`,
        outcome: "served" as const,
        createdAt: new Date(base - i * 60_000), // i = 0 is the newest
      }))
    );
    await tdb.db.insert(datasetDownloadsTable).values([
      { grantId: other.id, file: "other-1.csv", outcome: "served" },
      { grantId: other.id, file: "other-2.csv", outcome: "denied_rate" },
    ]);

    const log = await getDatasetDownloadLog(grant.id);

    expect(log).not.toBeNull();
    expect(log!.grant).toMatchObject({
      id: grant.id,
      name: "Log Subject",
      email: grant.email,
      status: "active",
      downloadCount: 55,
    });
    expect(log!.grant.lastDownloadAt).toBeInstanceOf(Date);
    expect(log!.downloads).toHaveLength(ADMIN_DOWNLOAD_LOG_LIMIT);
    expect(log!.downloads[0].file).toBe("file-0.csv");
    expect(log!.downloads[ADMIN_DOWNLOAD_LOG_LIMIT - 1].file).toBe(`file-${ADMIN_DOWNLOAD_LOG_LIMIT - 1}.csv`);
    expect(log!.downloads.every((d) => d.file.startsWith("file-"))).toBe(true);
    const times = log!.downloads.map((d) => d.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("returns the other grant's own rows and outcomes", async () => {
    await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
    const other = await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
    await tdb.db.insert(datasetDownloadsTable).values([
      { grantId: other.id, file: "other-1.csv", outcome: "served", createdAt: daysFromNow(-2) },
      { grantId: other.id, file: "other-2.csv", outcome: "denied_rate", createdAt: daysFromNow(-1) },
    ]);

    const log = await getDatasetDownloadLog(other.id);

    expect(log!.downloads.map((d) => [d.file, d.outcome, d.editionId])).toEqual([
      ["other-2.csv", "denied_rate", null],
      ["other-1.csv", "served", null],
    ]);
  });

  it("returns an empty list for a grant with no downloads", async () => {
    const grant = await insertGrant({ status: "pending_review" });

    const log = await getDatasetDownloadLog(grant.id);

    expect(log!.downloads).toEqual([]);
    expect(log!.grant.downloadCount).toBe(0);
    expect(log!.grant.lastDownloadAt).toBeNull();
  });

  it("returns null for a malformed id without touching the database", async () => {
    const select = vi.spyOn(tdb.db, "select");
    try {
      expect(await getDatasetDownloadLog("not-a-uuid")).toBeNull();
      expect(await getDatasetDownloadLog("")).toBeNull();
      expect(await getDatasetDownloadLog(123 as never)).toBeNull();
      expect(await getDatasetDownloadLog(undefined as never)).toBeNull();
      expect(select).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
  });

  it("returns null for a well-formed id that matches no grant", async () => {
    expect(await getDatasetDownloadLog("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("hasRecentLinkReissue", () => {
  const NOW = new Date("2026-11-09T12:00:00Z");
  const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 1000);

  async function insertSend(over: Partial<typeof emailSendsTable.$inferInsert> & { targetId: string }) {
    await tdb.db.insert(emailSendsTable).values({
      kind: "dataset_link_reissued",
      emailHash: "hash",
      targetType: "dataset",
      outcome: "sent",
      createdAt: minutesAgo(5),
      ...over,
    });
  }

  it("uses a 10 minute cooldown", () => {
    expect(DATASET_REISSUE_COOLDOWN_MS).toBe(10 * 60 * 1000);
  });

  it("is true for a sent reissue mail inside the cooldown", async () => {
    const grant = await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
    await insertSend({ targetId: grant.id, createdAt: minutesAgo(5) });
    expect(await hasRecentLinkReissue(grant.id, NOW)).toBe(true);
  });

  it("is false once the sent row is older than the cooldown", async () => {
    const grant = await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
    await insertSend({ targetId: grant.id, createdAt: minutesAgo(11) });
    expect(await hasRecentLinkReissue(grant.id, NOW)).toBe(false);
  });

  it("is false when there is no row at all", async () => {
    const grant = await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
    expect(await hasRecentLinkReissue(grant.id, NOW)).toBe(false);
  });

  it.each(["attempted", "error", "skipped_no_key", "skipped_suppressed", "skipped_check_failed", "skipped_capped", "send_failed"])(
    "ignores a recent %s row: a failed or skipped send stays retryable",
    async (outcome) => {
      const grant = await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
      await insertSend({ targetId: grant.id, outcome });
      expect(await hasRecentLinkReissue(grant.id, NOW)).toBe(false);
    }
  );

  it("ignores another grant's sent row", async () => {
    const grant = await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
    const other = await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
    await insertSend({ targetId: other.id });
    expect(await hasRecentLinkReissue(grant.id, NOW)).toBe(false);
  });

  it("ignores another mail kind for the same grant", async () => {
    const grant = await insertGrant({ status: "active", expiresAt: daysFromNow(10) });
    await insertSend({ targetId: grant.id, kind: "dataset_approved" });
    expect(await hasRecentLinkReissue(grant.id, NOW)).toBe(false);
  });

  it("returns false for a malformed id without touching the database", async () => {
    const select = vi.spyOn(tdb.db, "select");
    try {
      expect(await hasRecentLinkReissue("not-a-uuid", NOW)).toBe(false);
      expect(await hasRecentLinkReissue("", NOW)).toBe(false);
      expect(await hasRecentLinkReissue(123 as never, NOW)).toBe(false);
      expect(select).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
  });
});

describe("toAdminGrant", () => {
  const row = { id: "x", live: true, renewalPending: false } as never;

  it("passes real booleans through", () => {
    expect(toAdminGrant(row)).toMatchObject({ live: true, renewalPending: false });
  });

  it.each(["t", 1, null, undefined])("throws on a non-boolean lifecycle flag (%j)", (bad) => {
    expect(() => toAdminGrant({ ...(row as object), live: bad } as never)).toThrow("expected a boolean lifecycle flag");
    expect(() => toAdminGrant({ ...(row as object), renewalPending: bad } as never)).toThrow(
      "expected a boolean lifecycle flag"
    );
  });
});
