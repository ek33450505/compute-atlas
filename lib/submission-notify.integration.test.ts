// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { submissionNotifyRequestsTable } from "@/lib/db/schema";
import { checkSubmissionNotifyCap, EMAIL_SEND_CAP_MAX } from "@/lib/rate-limit";
import {
  deleteSubmissionNotifyRequest,
  getSubmissionNotifyRequest,
  recordSubmissionNotifyRequest,
  submissionNotifyEnabled,
} from "@/lib/submission-notify";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
  vi.mocked(dbClient.readsUseDatabase).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await tdb.client.close();
});

describe("submissionNotifyEnabled", () => {
  it("is false when the env var is unset", () => {
    expect(submissionNotifyEnabled()).toBe(false);
  });

  it("is true only for the exact string 'true'", () => {
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");
    expect(submissionNotifyEnabled()).toBe(true);
  });

  it("is false for a truthy-looking but non-exact value", () => {
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "1");
    expect(submissionNotifyEnabled()).toBe(false);
  });
});

describe("recordSubmissionNotifyRequest / getSubmissionNotifyRequest / deleteSubmissionNotifyRequest", () => {
  it("records a request and reads it back without deleting it", async () => {
    const submissionId = randomUUID();
    await recordSubmissionNotifyRequest(submissionId, "contributor@example.com");

    expect(await getSubmissionNotifyRequest(submissionId)).toEqual({
      email: "contributor@example.com",
    });
    // A second read sees the same row — get* must not consume it.
    expect(await getSubmissionNotifyRequest(submissionId)).toEqual({
      email: "contributor@example.com",
    });
  });

  it("returns null for a submission with no recorded request", async () => {
    expect(await getSubmissionNotifyRequest(randomUUID())).toBeNull();
  });

  it("a duplicate submissionId is a no-op: one row survives, no throw", async () => {
    const submissionId = randomUUID();
    await recordSubmissionNotifyRequest(submissionId, "first@example.com");

    await expect(
      recordSubmissionNotifyRequest(submissionId, "second@example.com")
    ).resolves.toBeUndefined();

    const rows = await tdb.db
      .select()
      .from(submissionNotifyRequestsTable)
      .where(eq(submissionNotifyRequestsTable.submissionId, submissionId));
    expect(rows).toHaveLength(1);
    // The unique-violation branch is a skip, not an upsert — the first write wins.
    expect(rows[0].email).toBe("first@example.com");
  });

  it("delete is idempotent, including against a submission with no row", async () => {
    const submissionId = randomUUID();
    await recordSubmissionNotifyRequest(submissionId, "gone@example.com");

    await deleteSubmissionNotifyRequest(submissionId);
    expect(await getSubmissionNotifyRequest(submissionId)).toBeNull();

    await expect(deleteSubmissionNotifyRequest(submissionId)).resolves.toBeUndefined();
    await expect(deleteSubmissionNotifyRequest(randomUUID())).resolves.toBeUndefined();
  });
});

describe("checkSubmissionNotifyCap", () => {
  it("allows a request when the address has no outstanding requests", async () => {
    expect((await checkSubmissionNotifyCap("under-cap@example.com")).ok).toBe(true);
  });

  it("refuses once EMAIL_SEND_CAP_MAX outstanding requests exist for the address", async () => {
    const email = "over-cap@example.com";
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) {
      await tdb.db.insert(submissionNotifyRequestsTable).values({ submissionId: randomUUID(), email });
    }
    expect((await checkSubmissionNotifyCap(email)).ok).toBe(false);
  });

  it("does not count another address's outstanding requests", async () => {
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) {
      await tdb.db
        .insert(submissionNotifyRequestsTable)
        .values({ submissionId: randomUUID(), email: "other@example.com" });
    }
    expect((await checkSubmissionNotifyCap("isolated@example.com")).ok).toBe(true);
  });
});
