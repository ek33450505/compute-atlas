// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("../lib/db/client");

import * as dbClient from "../lib/db/client";
import { makeTestDb, type TestDbHandle } from "../test/pglite-db";
import { apiAccessGrantsTable, subscriptionsTable } from "../lib/db/schema";
import { hashToken, isHashedToken } from "../lib/token-hash";
// Imported after the mocks above (mirrors the *.integration.test.ts files
// for lib/subscribe.ts and lib/access-grants.ts) so their transitive getDb()
// import resolves against the mocked client — used below to prove a
// pre-backfill raw link still confirms correctly post-backfill.
import { confirmSubscription } from "../lib/subscribe";
import { confirmAccessGrant } from "../lib/access-grants";
import { runHashTokensBackfill } from "./hash-tokens-backfill";

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

const RAW_SUB_CONFIRM = "raw-sub-confirm-token-1234567890";
const RAW_SUB_UNSUB = "raw-sub-unsubscribe-token-abcdefghi";
const ALREADY_HASHED_SUB_CONFIRM = hashToken("already-hashed-sub-confirm-source");

const RAW_GRANT_CONFIRM = "raw-grant-confirm-token-0987654321";
const RAW_GRANT_ACCESS = "raw-grant-access-token-zyxwvutsrq";
const ALREADY_HASHED_GRANT_CONFIRM = hashToken("already-hashed-grant-confirm-source");

/**
 * Seeds one raw + one already-hashed row per candidate column, plus a
 * pending grant whose accessToken is still null (must never become a
 * candidate). Returns the seeded ids for post-run assertions.
 */
async function seedRows() {
  const [subRaw] = await tdb.db
    .insert(subscriptionsTable)
    .values({
      email: "raw-sub@example.com",
      targetType: "facility",
      targetId: "facility-a",
      status: "pending",
      confirmToken: RAW_SUB_CONFIRM,
      unsubscribeToken: RAW_SUB_UNSUB,
    })
    .returning({ id: subscriptionsTable.id });

  const [subHashed] = await tdb.db
    .insert(subscriptionsTable)
    .values({
      email: "hashed-sub@example.com",
      targetType: "facility",
      targetId: "facility-b",
      status: "confirmed",
      confirmToken: ALREADY_HASHED_SUB_CONFIRM,
      unsubscribeToken: "some-other-unsub-token",
    })
    .returning({ id: subscriptionsTable.id });

  const [grantRawBoth] = await tdb.db
    .insert(apiAccessGrantsTable)
    .values({
      email: "raw-grant@example.com",
      status: "active",
      confirmToken: RAW_GRANT_CONFIRM,
      accessToken: RAW_GRANT_ACCESS,
    })
    .returning({ id: apiAccessGrantsTable.id });

  const [grantHashedPending] = await tdb.db
    .insert(apiAccessGrantsTable)
    .values({
      email: "hashed-pending-grant@example.com",
      status: "pending",
      confirmToken: ALREADY_HASHED_GRANT_CONFIRM,
      // accessToken stays null — not yet confirmed; must never be a candidate.
    })
    .returning({ id: apiAccessGrantsTable.id });

  return {
    subRaw: subRaw.id,
    subHashed: subHashed.id,
    grantRawBoth: grantRawBoth.id,
    grantHashedPending: grantHashedPending.id,
  };
}

describe("runHashTokensBackfill — dry run", () => {
  it("counts candidates per column but writes nothing", async () => {
    await seedRows();

    const summary = await runHashTokensBackfill({ apply: false });

    expect(summary.dryRun).toBe(true);
    expect(summary.ok).toBe(true);

    const byColumn = Object.fromEntries(summary.columns.map((c) => [`${c.table}.${c.column}`, c]));
    expect(byColumn["subscriptions.confirm_token"]).toMatchObject({ candidates: 1, applied: 0 });
    expect(byColumn["api_access_grants.confirm_token"]).toMatchObject({ candidates: 1, applied: 0 });
    expect(byColumn["api_access_grants.access_token"]).toMatchObject({ candidates: 1, applied: 0 });

    // Nothing written — the raw row is still raw, byte for byte.
    const [subRawRow] = await tdb.db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.email, "raw-sub@example.com"));
    expect(subRawRow.confirmToken).toBe(RAW_SUB_CONFIRM);
    expect(subRawRow.unsubscribeToken).toBe(RAW_SUB_UNSUB);
  });
});

describe("runHashTokensBackfill — apply", () => {
  it("hashes exactly the raw confirm/access values; leaves already-hashed rows and unsubscribe_token untouched", async () => {
    const ids = await seedRows();

    const summary = await runHashTokensBackfill({ apply: true });

    expect(summary.dryRun).toBe(false);
    expect(summary.ok).toBe(true);
    const byColumn = Object.fromEntries(summary.columns.map((c) => [`${c.table}.${c.column}`, c]));
    expect(byColumn["subscriptions.confirm_token"]).toMatchObject({ candidates: 1, applied: 1 });
    expect(byColumn["api_access_grants.confirm_token"]).toMatchObject({ candidates: 1, applied: 1 });
    expect(byColumn["api_access_grants.access_token"]).toMatchObject({ candidates: 1, applied: 1 });

    const [subRaw] = await tdb.db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, ids.subRaw));
    expect(isHashedToken(subRaw.confirmToken)).toBe(true);
    expect(subRaw.confirmToken).toBe(hashToken(RAW_SUB_CONFIRM));
    // unsubscribe_token is NEVER a candidate — must survive byte for byte.
    expect(subRaw.unsubscribeToken).toBe(RAW_SUB_UNSUB);

    const [subHashed] = await tdb.db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, ids.subHashed));
    expect(subHashed.confirmToken).toBe(ALREADY_HASHED_SUB_CONFIRM); // untouched — already hashed

    const [grantRawBoth] = await tdb.db
      .select()
      .from(apiAccessGrantsTable)
      .where(eq(apiAccessGrantsTable.id, ids.grantRawBoth));
    expect(grantRawBoth.confirmToken).toBe(hashToken(RAW_GRANT_CONFIRM));
    expect(grantRawBoth.accessToken).toBe(hashToken(RAW_GRANT_ACCESS));

    const [grantHashedPending] = await tdb.db
      .select()
      .from(apiAccessGrantsTable)
      .where(eq(apiAccessGrantsTable.id, ids.grantHashedPending));
    expect(grantHashedPending.confirmToken).toBe(ALREADY_HASHED_GRANT_CONFIRM); // untouched
    expect(grantHashedPending.accessToken).toBeNull(); // still null — never a candidate
  });

  it("is idempotent — running twice hashes nothing the second time", async () => {
    await seedRows();
    const first = await runHashTokensBackfill({ apply: true });
    expect(first.columns.some((c) => c.applied > 0)).toBe(true);

    const second = await runHashTokensBackfill({ apply: true });
    for (const c of second.columns) {
      expect(c.candidates).toBe(0);
      expect(c.applied).toBe(0);
    }
  });

  it("a pre-backfill raw confirm link still works after the backfill runs", async () => {
    // Self-contained seed (not seedRows()) so these rows don't perturb the
    // candidate-count assertions in the tests above. Both rows are seeded
    // PENDING with a raw confirmToken — the backfill below rewrites that
    // column to its hash, then each raw link (what an email recipient
    // actually holds) is presented and must still resolve via the primary
    // hash-first lookup, proving the backfill's hash matches what the
    // confirm functions compute for the same raw value.
    const rawSubPending = "raw-sub-confirm-pending-for-post-backfill-check";
    const [subRow] = await tdb.db
      .insert(subscriptionsTable)
      .values({
        email: "post-backfill-sub@example.com",
        targetType: "facility",
        targetId: "facility-z",
        status: "pending",
        confirmToken: rawSubPending,
        unsubscribeToken: "post-backfill-unsub-token",
      })
      .returning({ id: subscriptionsTable.id });

    const rawGrantPending = "raw-grant-confirm-pending-for-post-backfill-check";
    await tdb.db.insert(apiAccessGrantsTable).values({
      email: "post-backfill-grant@example.com",
      status: "pending",
      confirmToken: rawGrantPending,
    });

    await runHashTokensBackfill({ apply: true });

    const subResult = await confirmSubscription(rawSubPending);
    expect(subResult.status).toBe("confirmed");
    const [updatedSub] = await tdb.db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subRow.id));
    expect(updatedSub.status).toBe("confirmed");

    const grantResult = await confirmAccessGrant(rawGrantPending);
    expect(grantResult.status).toBe("active");
  });
});
