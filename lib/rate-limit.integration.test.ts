// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { subscribeAttemptsTable, submissionNotifySendsTable, subscriptionsTable } from "@/lib/db/schema";

import {
  checkSubscribeRateLimit,
  recordSubscribeAttempt,
  checkSubmissionNotifySendCap,
  recordSubmissionNotifySend,
  hashNotifyEmail,
  SUBMISSION_NOTIFY_SEND_CAP_MAX,
  SUBMISSION_NOTIFY_SEND_WINDOW_MS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from "@/lib/rate-limit";

let tdb: TestDbHandle;

const IP_HASH = "hash-under-test";
const OTHER_IP_HASH = "hash-someone-else";

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

/** Inserts `n` attempt rows for `ipHash`, all stamped `ageMs` in the past. */
async function seedAttempts(ipHash: string, n: number, ageMs = 0): Promise<void> {
  const createdAt = new Date(Date.now() - ageMs);
  for (let i = 0; i < n; i++) {
    await tdb.db.insert(subscribeAttemptsTable).values({ submitterIpHash: ipHash, createdAt });
  }
}

describe("recordSubscribeAttempt", () => {
  it("writes exactly one row per call, carrying only the ip hash", async () => {
    await recordSubscribeAttempt(IP_HASH);

    const rows = await tdb.db.select().from(subscribeAttemptsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].submitterIpHash).toBe(IP_HASH);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    // The row's shape is part of the contract: an attempt must reveal nothing
    // about which branch the request took, so there is no email/target/outcome.
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "id", "submitterIpHash"]);
  });

  it("does not swallow a write failure — it must fail closed so the route can refuse", async () => {
    // A schema-level violation the driver rejects: NOT NULL on submitter_ip_hash.
    await expect(recordSubscribeAttempt(null as unknown as string)).rejects.toThrow();
  });
});

describe("checkSubscribeRateLimit", () => {
  it("allows while prior attempts are below the max and blocks at the max", async () => {
    expect((await checkSubscribeRateLimit(IP_HASH)).ok).toBe(true);

    await seedAttempts(IP_HASH, RATE_LIMIT_MAX - 1);
    expect((await checkSubscribeRateLimit(IP_HASH)).ok).toBe(true);

    await seedAttempts(IP_HASH, 1);
    expect((await checkSubscribeRateLimit(IP_HASH)).ok).toBe(false);
  });

  it("counts a row just inside the window and ignores one just outside it", async () => {
    // One minute inside the window — counted.
    await seedAttempts(IP_HASH, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS - 60_000);
    expect((await checkSubscribeRateLimit(IP_HASH)).ok).toBe(false);

    await tdb.reset();

    // One minute outside the window — expired, so the budget is untouched.
    await seedAttempts(IP_HASH, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS + 60_000);
    expect((await checkSubscribeRateLimit(IP_HASH)).ok).toBe(true);
  });

  it("buckets per ip hash — another ip's attempts never consume this one's budget", async () => {
    await seedAttempts(OTHER_IP_HASH, RATE_LIMIT_MAX * 2);
    expect((await checkSubscribeRateLimit(IP_HASH)).ok).toBe(true);
    expect((await checkSubscribeRateLimit(OTHER_IP_HASH)).ok).toBe(false);
  });

  it("counts attempts, NOT successful subscriptions — this is the defect it was rewritten to fix", async () => {
    // The old implementation counted `subscriptions` rows, so requests that
    // never inserted were free. Subscriptions alone must now move nothing.
    for (let i = 0; i < RATE_LIMIT_MAX * 2; i++) {
      await tdb.db.insert(subscriptionsTable).values({
        email: `user${i}@example.com`,
        targetType: "facility",
        targetId: `facility-${i}`,
        status: "pending",
        confirmToken: `tok-${i}`,
        unsubscribeToken: `unsub-${i}`,
        submitterIpHash: IP_HASH,
      });
    }
    expect((await checkSubscribeRateLimit(IP_HASH)).ok).toBe(true);

    // Attempts alone are what close the budget.
    await seedAttempts(IP_HASH, RATE_LIMIT_MAX);
    expect((await checkSubscribeRateLimit(IP_HASH)).ok).toBe(false);
  });
});

// C1b Unit D: the persistent send-attempt counter that replaces
// checkSubmissionNotifyCap for actually bounding mail volume — see
// submissionNotifySendsTable's doc comment in lib/db/schema.ts for the
// attack this closes (that cap's rows are deleted at review time, resetting
// to zero; this table's rows are not).
const NOTIFY_EMAIL = "under-test@example.com";
const OTHER_NOTIFY_EMAIL = "someone-else@example.com";

/** Inserts `n` already-hashed send rows for `email`, all stamped `ageMs` in the past. */
async function seedSends(email: string, n: number, ageMs = 0): Promise<void> {
  const createdAt = new Date(Date.now() - ageMs);
  const emailHash = hashNotifyEmail(email);
  for (let i = 0; i < n; i++) {
    await tdb.db.insert(submissionNotifySendsTable).values({ emailHash, createdAt });
  }
}

describe("recordSubmissionNotifySend", () => {
  it("writes exactly one row per call, carrying only the salted hash", async () => {
    await recordSubmissionNotifySend(NOTIFY_EMAIL);

    const rows = await tdb.db.select().from(submissionNotifySendsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].emailHash).toBe(hashNotifyEmail(NOTIFY_EMAIL));
    // The raw address is never stored — same discipline as every other
    // per-address counter in this file.
    expect(rows[0].emailHash).not.toBe(NOTIFY_EMAIL);
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "emailHash", "id"]);
  });
});

describe("checkSubmissionNotifySendCap", () => {
  it("allows while prior sends are below the max and blocks at the max", async () => {
    expect((await checkSubmissionNotifySendCap(NOTIFY_EMAIL)).ok).toBe(true);

    await seedSends(NOTIFY_EMAIL, SUBMISSION_NOTIFY_SEND_CAP_MAX - 1);
    expect((await checkSubmissionNotifySendCap(NOTIFY_EMAIL)).ok).toBe(true);

    await seedSends(NOTIFY_EMAIL, 1);
    expect((await checkSubmissionNotifySendCap(NOTIFY_EMAIL)).ok).toBe(false);
  });

  // Pinned against a literal, not derived from the constant under test — a
  // fixture written as `seedSends(EMAIL, SUBMISSION_NOTIFY_SEND_CAP_MAX)`
  // would move in lockstep with the constant and stay green even if the
  // threshold were raised.
  it("SUBMISSION_NOTIFY_SEND_CAP_MAX is 5", () => {
    expect(SUBMISSION_NOTIFY_SEND_CAP_MAX).toBe(5);
  });

  it("counts a row just inside the 30-day window and ignores one just outside it", async () => {
    // One hour inside the window — counted.
    await seedSends(NOTIFY_EMAIL, SUBMISSION_NOTIFY_SEND_CAP_MAX, SUBMISSION_NOTIFY_SEND_WINDOW_MS - 60 * 60 * 1000);
    expect((await checkSubmissionNotifySendCap(NOTIFY_EMAIL)).ok).toBe(false);

    await tdb.reset();

    // One hour outside the window — expired, so the budget is untouched.
    await seedSends(NOTIFY_EMAIL, SUBMISSION_NOTIFY_SEND_CAP_MAX, SUBMISSION_NOTIFY_SEND_WINDOW_MS + 60 * 60 * 1000);
    expect((await checkSubmissionNotifySendCap(NOTIFY_EMAIL)).ok).toBe(true);
  });

  it("buckets per address hash — another address's sends never consume this one's budget", async () => {
    await seedSends(OTHER_NOTIFY_EMAIL, SUBMISSION_NOTIFY_SEND_CAP_MAX * 2);
    expect((await checkSubmissionNotifySendCap(NOTIFY_EMAIL)).ok).toBe(true);
    expect((await checkSubmissionNotifySendCap(OTHER_NOTIFY_EMAIL)).ok).toBe(false);
  });
});

// The actual defect this table exists to fix — checkSubmissionNotifyCap's
// rows are deleted the moment a submission is reviewed, resetting THAT cap to
// zero — is exercised end-to-end (through notifySubmitterOfReview, deleting a
// real submission_notify_requests row) in
// lib/submissions.integration.test.ts, not here: this file has no submission
// to review, so a same-file version of that test could only ever assert
// "nothing touched this table," which would pass identically whether or not
// the fix existed.
