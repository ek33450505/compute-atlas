// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

// "email me when reviewed" (Unit B) needs a real send path to assert against
// without hitting the network — same mock shape as
// app/api/subscribe/route.integration.test.ts and lib/email.test.ts.
const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import {
  facilitiesTable,
  facilityHistoryTable,
  submissionsTable,
  submissionNotifyRequestsTable,
  submissionNotifySendsTable,
} from "@/lib/db/schema";
import type { DataCenterFacility, Source } from "@/lib/schema";
import { recordSubmissionNotifyRequest } from "@/lib/submission-notify";
import { hashNotifyEmail, SUBMISSION_NOTIFY_SEND_CAP_MAX } from "@/lib/rate-limit";

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { approveSubmission, createSubmission, rejectSubmission } from "@/lib/submissions";

function makeSource(label: string): Source {
  return {
    url: `https://example.com/${label}`,
    label,
    retrievedAt: "2026-01-01",
    kind: "other" as const,
  };
}

function makeSeedDoc(): DataCenterFacility {
  return {
    id: "submissions-status-update-test-facility",
    name: "Submissions Status Update Test Facility",
    operator: "Test Operator",
    facilityType: "data_center",
    status: "under_construction",
    confidence: "confirmed",
    location: { lat: 33.4, lon: -84.4, state: "GA", precision: "exact" },
    statusHistory: [],
    sources: [makeSource("s0")],
    lastUpdated: "2025-06-01",
  };
}

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await tdb.client.close();
});

async function insertSubmission(values: {
  kind: "create" | "update" | "status_update" | "enrichment_update";
  targetFacilityId?: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const [row] = await tdb.db
    .insert(submissionsTable)
    .values({
      kind: values.kind,
      targetFacilityId: values.targetFacilityId,
      payload: values.payload,
      provenance: { sources: ["https://example.com/x"], discoveredBy: "test" },
      status: "pending",
    })
    .returning({ id: submissionsTable.id });
  return row.id;
}

describe("approveSubmission (kind: status_update)", () => {
  it("promotes a pending status_update submission: applies the intent and marks the submission approved", async () => {
    const seedDoc = makeSeedDoc();
    await seedFacility(tdb.db, seedDoc);
    const id = await insertSubmission({
      kind: "status_update",
      targetFacilityId: seedDoc.id,
      payload: {
        status: "operational",
        date: "2026-07-16",
        sources: [makeSource("corroboration")],
      },
    });

    const result = await approveSubmission(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facility.status).toBe("operational");
    expect(result.facility.sources).toHaveLength(2);

    const facilityRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    expect(facilityRows[0].doc.status).toBe("operational");

    const submissionRows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));
    expect(submissionRows[0].status).toBe("approved");

    const historyRows = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, seedDoc.id));
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0].changeType).toBe("update");
    expect(historyRows[0].source).toBe(id);
  });

  it("leaves the submission pending when the status_update payload is invalid", async () => {
    const seedDoc = makeSeedDoc();
    await seedFacility(tdb.db, seedDoc);
    const id = await insertSubmission({
      kind: "status_update",
      targetFacilityId: seedDoc.id,
      payload: { status: "operational", date: "2026-07-16", sources: [] },
    });

    const result = await approveSubmission(id);
    expect(result.ok).toBe(false);

    const submissionRows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));
    expect(submissionRows[0].status).toBe("pending");
  });
});

describe("approveSubmission (kind: enrichment_update)", () => {
  it("promotes a pending enrichment_update submission: fills a missing field and marks the submission approved", async () => {
    const seedDoc = makeSeedDoc();
    await seedFacility(tdb.db, seedDoc);
    const id = await insertSubmission({
      kind: "enrichment_update",
      targetFacilityId: seedDoc.id,
      payload: {
        date: "2026-07-16",
        sources: [makeSource("enrichment")],
        fields: { energy: { source: "grid" } },
      },
    });

    const result = await approveSubmission(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facility.energy?.source).toBe("grid");
    expect(result.facility.sources).toHaveLength(2);

    const facilityRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    expect(facilityRows[0].doc.energy?.source).toBe("grid");

    const submissionRows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));
    expect(submissionRows[0].status).toBe("approved");

    const historyRows = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, seedDoc.id));
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0].changeType).toBe("update");
    expect(historyRows[0].source).toBe(id);
  });

  it("leaves the submission pending when the enrichment_update payload is invalid", async () => {
    const seedDoc = makeSeedDoc();
    await seedFacility(tdb.db, seedDoc);
    const id = await insertSubmission({
      kind: "enrichment_update",
      targetFacilityId: seedDoc.id,
      payload: { date: "2026-07-16", sources: [], fields: { energy: { source: "grid" } } },
    });

    const result = await approveSubmission(id);
    expect(result.ok).toBe(false);

    const submissionRows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));
    expect(submissionRows[0].status).toBe("pending");
  });
});

// Persistence-boundary hardening: provenanceSchema.attribution must enforce
// the same charset allowlist as sanitizeAttribution() (lib/contribute.ts),
// so the admin-token POST /api/submissions path and the discovery pipeline
// can't bypass it by writing an unsanitized handle directly.
describe("createSubmission (provenance.attribution charset boundary)", () => {
  it("rejects an envelope whose provenance.attribution contains a disallowed character", async () => {
    const result = await createSubmission({
      kind: "create",
      payload: { name: "Example Facility" },
      provenance: {
        sources: ["https://example.com/x"],
        discoveredBy: "test",
        attribution: "a<b",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("accepts a clean provenance.attribution containing a space", async () => {
    const result = await createSubmission({
      kind: "create",
      payload: { name: "Example Facility" },
      provenance: {
        sources: ["https://example.com/x"],
        discoveredBy: "test",
        attribution: "grid watcher",
      },
    });

    expect(result.ok).toBe(true);
  });
});

/** Rows currently in submission_notify_requests for `submissionId` — used to assert the send-and-delete contract. */
async function notifyRowsFor(submissionId: string) {
  return tdb.db
    .select()
    .from(submissionNotifyRequestsTable)
    .where(eq(submissionNotifyRequestsTable.submissionId, submissionId));
}

/** Rows currently in submission_notify_sends for `email`'s hash — the persistent send-attempt counter (C1b Unit D). */
async function sendRowsFor(email: string) {
  return tdb.db
    .select()
    .from(submissionNotifySendsTable)
    .where(eq(submissionNotifySendsTable.emailHash, hashNotifyEmail(email)));
}

async function seedStatusUpdateSubmission(seedDoc: DataCenterFacility): Promise<string> {
  await seedFacility(tdb.db, seedDoc);
  return insertSubmission({
    kind: "status_update",
    targetFacilityId: seedDoc.id,
    payload: { status: "operational", date: "2026-07-16", sources: [makeSource("corroboration")] },
  });
}

// Unit B, "email me when reviewed": the send-and-delete path. approveSubmission
// and rejectSubmission both call the same private notifySubmitterOfReview
// helper after their status update — these tests exercise it through the
// public entry points, since it is not itself exported.
describe("approveSubmission / rejectSubmission → notifySubmitterOfReview", () => {
  it("approve + flag ON + notify row present: sends exactly one email with the facility link, then deletes the row", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const seedDoc = makeSeedDoc();
    const id = await seedStatusUpdateSubmission(seedDoc);
    await recordSubmissionNotifyRequest(id, "watcher@example.com");

    const result = await approveSubmission(id);
    expect(result.ok).toBe(true);

    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe("watcher@example.com");
    expect(args.html).toContain(`/facilities/${seedDoc.id}`);

    expect(await notifyRowsFor(id)).toHaveLength(0);
  });

  it("reject + flag ON + notify row present: sends exactly one email with copy DIFFERENT from the approve case, then deletes the row", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const id = await insertSubmission({ kind: "create", payload: { name: "Rejected Example Facility" } });
    await recordSubmissionNotifyRequest(id, "hopeful@example.com");

    const result = await rejectSubmission(id, "couldn't verify from the cited source");
    expect(result.ok).toBe(true);

    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe("hopeful@example.com");
    expect(args.html).toContain("Rejected Example Facility");
    expect(args.html).toContain("not published");
    // Different copy from the approve case — never claims publication.
    expect(args.html).not.toContain("is now live");
    expect(args.html).not.toContain("has been reviewed and published <strong>Rejected");

    expect(await notifyRowsFor(id)).toHaveLength(0);
  });

  it("send failure (Resend returns an error): the row is still deleted, and approval still returns its normal success result", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");
    resendSendMock.mockResolvedValue({ data: null, error: { name: "validation_error" } });

    const seedDoc = makeSeedDoc();
    const id = await seedStatusUpdateSubmission(seedDoc);
    await recordSubmissionNotifyRequest(id, "watcher@example.com");

    const result = await approveSubmission(id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facility.status).toBe("operational");
    }

    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(await notifyRowsFor(id)).toHaveLength(0);
  });

  it("no notify row: approve and reject each send nothing and throw nothing", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const approveId = await seedStatusUpdateSubmission(makeSeedDoc());
    await expect(approveSubmission(approveId)).resolves.toMatchObject({ ok: true });
    expect(resendSendMock).not.toHaveBeenCalled();

    const rejectId = await insertSubmission({ kind: "create", payload: { name: "No Notify Facility" } });
    await expect(rejectSubmission(rejectId, "no usable source")).resolves.toMatchObject({ ok: true });
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("flag OFF with a notify row present: nothing sent, row still deleted", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    // SUBMISSION_NOTIFY_ENABLED intentionally left unset.

    const seedDoc = makeSeedDoc();
    const id = await seedStatusUpdateSubmission(seedDoc);
    await recordSubmissionNotifyRequest(id, "watcher@example.com");

    const result = await approveSubmission(id);
    expect(result.ok).toBe(true);
    expect(resendSendMock).not.toHaveBeenCalled();

    expect(await notifyRowsFor(id)).toHaveLength(0);
  });

  // C1b Unit D (security fix): checkSubmissionNotifyCap alone counted
  // OUTSTANDING submission_notify_requests rows, which are deleted by this
  // same review path — so approving/rejecting the queue reset that cap to
  // zero on every review, and mail volume to one address was unbounded over
  // time. submission_notify_sends is the persistent counter that closes that
  // hole; these four tests exercise it through the real review path, not
  // just the rate-limit functions directly (see lib/rate-limit.integration.test.ts
  // for those).
  describe("send-cap gating (submission_notify_sends)", () => {
    it("under the cap: sends the email and records exactly one send-attempt row", async () => {
      vi.stubEnv("RESEND_API_KEY", "test-key");
      vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

      const seedDoc = makeSeedDoc();
      const id = await seedStatusUpdateSubmission(seedDoc);
      await recordSubmissionNotifyRequest(id, "watcher@example.com");

      const result = await approveSubmission(id);
      expect(result.ok).toBe(true);

      expect(resendSendMock).toHaveBeenCalledTimes(1);
      expect(await sendRowsFor("watcher@example.com")).toHaveLength(1);
    });

    it("at the cap: no email is sent, but the notify-request row is still deleted", async () => {
      vi.stubEnv("RESEND_API_KEY", "test-key");
      vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

      const email = "over-cap@example.com";
      const emailHash = hashNotifyEmail(email);
      for (let i = 0; i < SUBMISSION_NOTIFY_SEND_CAP_MAX; i++) {
        await tdb.db.insert(submissionNotifySendsTable).values({ emailHash });
      }

      const seedDoc = makeSeedDoc();
      const id = await seedStatusUpdateSubmission(seedDoc);
      await recordSubmissionNotifyRequest(id, email);

      const result = await approveSubmission(id);
      expect(result.ok).toBe(true);

      // The counter-intuitive half: no send, YET the request row is gone —
      // "skip the send" must never mean "keep the row for a later retry."
      expect(resendSendMock).not.toHaveBeenCalled();
      expect(await notifyRowsFor(id)).toHaveLength(0);
      // Still exactly CAP_MAX rows — an over-cap review must not itself add
      // another send-attempt row (nothing was sent, so nothing to record).
      expect(await sendRowsFor(email)).toHaveLength(SUBMISSION_NOTIFY_SEND_CAP_MAX);
    });

    // "Attempts, not outcomes" (PR #288's lesson, applied here): the send
    // attempt is recorded BEFORE sendSubmissionReviewedEmail is even called,
    // so a failing send still spends the address's budget. Mutation-checked
    // by moving the record call after the send in lib/submissions.ts and
    // confirming this test fails.
    it("a failing send still records the send-attempt row", async () => {
      vi.stubEnv("RESEND_API_KEY", "test-key");
      vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");
      resendSendMock.mockResolvedValue({ data: null, error: { name: "validation_error" } });

      const seedDoc = makeSeedDoc();
      const id = await seedStatusUpdateSubmission(seedDoc);
      await recordSubmissionNotifyRequest(id, "watcher@example.com");

      const result = await approveSubmission(id);
      expect(result.ok).toBe(true);

      expect(resendSendMock).toHaveBeenCalledTimes(1);
      expect(await sendRowsFor("watcher@example.com")).toHaveLength(1);
    });

    // The actual defect this fix closes: checkSubmissionNotifyCap's rows are
    // deleted the instant a submission is reviewed, resetting THAT cap to
    // zero on every review. This counter must survive the exact deletion
    // that used to reset the old one.
    it("the send-attempt row survives the notify-request row's deletion", async () => {
      vi.stubEnv("RESEND_API_KEY", "test-key");
      vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

      const seedDoc = makeSeedDoc();
      const id = await seedStatusUpdateSubmission(seedDoc);
      await recordSubmissionNotifyRequest(id, "watcher@example.com");

      await approveSubmission(id);

      expect(await notifyRowsFor(id)).toHaveLength(0); // deleted, as always
      expect(await sendRowsFor("watcher@example.com")).toHaveLength(1); // survives
    });
  });
});
