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

/**
 * Injectors for the three redaction sites that no DB patch can reach.
 *
 * `lib/submissions.ts:170` and `:214` are belt-and-suspenders catches around
 * calls that, today, provably never throw — every statement inside
 * `notifySubmitterOfReview` is individually guarded, and
 * `notifySubscribersOfChange` wraps its whole body. So the ONLY way to exercise
 * those two catches is to violate that no-throw contract deliberately, which is
 * exactly the scenario their own comments name ("in case that no-throw contract
 * is ever violated"). `submissionNotifyEnabled()` at :285 is the one unguarded
 * statement in that subtree, so it is the stand-in for "a throw escaping from
 * anywhere in here."
 *
 * `:318` wraps `sendSubmissionReviewedEmail`, which bottoms out in
 * `sendViaResend` and catches its own errors — so it is injected here too.
 *
 * Both mocks spread the real module and default to the real implementation, so
 * every other test in this file runs against the genuine code path; the flags
 * are reset in `afterEach`. Plain wrappers rather than `vi.fn`s on purpose:
 * `clearMocks: true` (vitest.config.ts) must not be able to strip them.
 */
const contractViolation = vi.hoisted(() => ({
  submissionNotifyEnabled: null as Error | null,
  sendSubmissionReviewedEmail: null as Error | null,
}));

vi.mock("@/lib/submission-notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/submission-notify")>();
  return {
    ...actual,
    submissionNotifyEnabled: () => {
      if (contractViolation.submissionNotifyEnabled) throw contractViolation.submissionNotifyEnabled;
      return actual.submissionNotifyEnabled();
    },
  };
});

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendSubmissionReviewedEmail: (
      ...args: Parameters<typeof actual.sendSubmissionReviewedEmail>
    ) => {
      if (contractViolation.sendSubmissionReviewedEmail) {
        throw contractViolation.sendSubmissionReviewedEmail;
      }
      return actual.sendSubmissionReviewedEmail(...args);
    },
  };
});

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
  contractViolation.submissionNotifyEnabled = null;
  contractViolation.sendSubmissionReviewedEmail = null;
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

/**
 * Security review, 2026-09-27: every DB statement `notifySubmitterOfReview`
 * runs binds the submitter's email address or its salted hash, so each of its
 * catch blocks logs `redactedErrorCode(err)` and never `err` itself — a
 * DrizzleQueryError's own `.message` is `Failed query: <sql> params: <bound
 * values>` (see lib/db-error.ts). Seven such call sites exist in
 * lib/submissions.ts and none were pinned, so a refactor back to
 * `console.error("…", err)` would have reintroduced the leak with the whole
 * suite green.
 *
 * ALL SEVEN are now pinned, one test each, and each asserts its OWN message
 * literal — so no test can be satisfied by another site's output. The fixture
 * differs by site because what the site actually handles differs:
 *
 * - `:290` / `:300` — the send-cap COUNT and the send-attempt INSERT both bind
 *   `hashNotifyEmail(email)` (lib/rate-limit.ts), so the hash is the secret.
 * - `:280` / `:331` — the lookup and the delete bind only the submission's uuid.
 * - `:170` / `:214` — belt-and-suspenders catches; see `contractViolation` at the
 *   top of this file for why they need an injected throw and what stands in.
 * - `:318` — a RESEND call, not a query. A SQLSTATE fixture there would be
 *   fiction, so it uses the real failure shape for that path: an undici fetch
 *   error carrying `code` on `.cause`, with the recipient address in its
 *   message (Resend echoes the address back on a validation error — see
 *   lib/email.ts's own note about that).
 *
 * Each test also pins the control flow that must not change alongside the
 * logging, because most of these paths fail CLOSED and the flow is the reason
 * the redaction is safe to add: nothing is sent, the notify-request row's fate
 * is whatever that site's contract says, and the review itself still succeeds.
 */
describe("notifySubmitterOfReview — a DB failure is logged redacted, never as the error object", () => {
  /**
   * A DrizzleQueryError's real shape: the bound params sit in the WRAPPER's own
   * `.message`, the SQLSTATE one level down on `.cause`. The `code` is
   * mandatory — a bare Error makes `redactedErrorCode` return "unknown", which
   * would turn the sqlstate assertions below into false proxies that pass for
   * the wrong reason.
   */
  function drizzleQueryError(sql: string, boundParam: string): Error {
    const driverError = Object.assign(
      new Error('relation "submission_notify_sends" does not exist'),
      { code: "42P01" }
    );
    return new Error(`Failed query: ${sql} params: ${boundParam}`, { cause: driverError });
  }

  /**
   * Makes only the statements that read `table` throw, leaving the rest of the
   * approve path (submission lookup, facility write, subscriber notify) running
   * against the real PGlite DB. Same "patch the db handle" technique as the
   * sibling cases in lib/subscribe.integration.test.ts and
   * lib/api-daily-limit.integration.test.ts. The returned restore is
   * idempotent, so a test can narrow the patch to the single call under test
   * and still restore in `finally`.
   */
  function failSelectsFrom(table: unknown, err: Error): () => void {
    const db = tdb.db as unknown as { select: (...args: unknown[]) => unknown };
    const original = db.select.bind(tdb.db);
    db.select = (...args: unknown[]) => {
      const builder = original(...args) as { from: (t: unknown) => unknown };
      const originalFrom = builder.from.bind(builder);
      builder.from = (t: unknown) => {
        if (t === table) throw err;
        return originalFrom(t);
      };
      return builder;
    };
    return () => {
      db.select = original;
    };
  }

  /** `failSelectsFrom`'s INSERT twin — drizzle takes the table as insert()'s first argument. */
  function failInsertsInto(table: unknown, err: Error): () => void {
    const db = tdb.db as unknown as { insert: (...args: unknown[]) => unknown };
    const original = db.insert.bind(tdb.db);
    db.insert = (t: unknown, ...rest: unknown[]) => {
      if (t === table) throw err;
      return original(t, ...rest);
    };
    return () => {
      db.insert = original;
    };
  }

  /** `failInsertsInto`'s DELETE twin — same first-argument-is-the-table shape. */
  function failDeletesFrom(table: unknown, err: Error): () => void {
    const db = tdb.db as unknown as { delete: (...args: unknown[]) => unknown };
    const original = db.delete.bind(tdb.db);
    db.delete = (t: unknown, ...rest: unknown[]) => {
      if (t === table) throw err;
      return original(t, ...rest);
    };
    return () => {
      db.delete = original;
    };
  }

  it("send-cap check failure: logs a SQLSTATE, never the address hash, and fails closed", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const email = "cap-check-fails@example.com";
    const emailHash = hashNotifyEmail(email);
    const seedDoc = makeSeedDoc();
    const id = await seedStatusUpdateSubmission(seedDoc);
    await recordSubmissionNotifyRequest(id, email);

    // checkSubmissionNotifySendCap's COUNT binds the hash, not the plaintext
    // address — so the hash is what the fixture embeds and what must not reach
    // the log.
    const dbError = drizzleQueryError(
      'select count(*)::int from "submission_notify_sends" where "created_at" > $1 and "email_hash" = $2',
      emailHash
    );
    // Sanity-check the fixture: if the hash were not really in the error, this
    // test could pass with nothing having been redacted.
    expect(dbError.message).toContain(emailHash);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restoreSelect = failSelectsFrom(submissionNotifySendsTable, dbError);

    try {
      const approved = await approveSubmission(id);
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      restoreSelect(); // narrow the patch to the one call under test

      expect(logged).toContain("notifySubmitterOfReview: send-cap check failed");
      expect(logged).toContain("42P01");
      expect(logged).not.toContain(emailHash);
      expect(logged).not.toContain(email);

      // The control flow the redaction must not disturb: an unverifiable cap
      // fails closed (no send, nothing recorded), the request row is still
      // deleted, and a notification failure never turns a successful approval
      // into an error response.
      expect(approved.ok).toBe(true);
      if (approved.ok) expect(approved.facility.status).toBe("operational");
      expect(resendSendMock).not.toHaveBeenCalled();
      expect(await sendRowsFor(email)).toHaveLength(0);
      expect(await notifyRowsFor(id)).toHaveLength(0);
    } finally {
      restoreSelect();
      errorSpy.mockRestore();
    }
  });

  it("send-record failure: logs a SQLSTATE, never the address hash, and sends nothing unrecorded", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const email = "record-fails@example.com";
    const emailHash = hashNotifyEmail(email);
    const seedDoc = makeSeedDoc();
    const id = await seedStatusUpdateSubmission(seedDoc);
    await recordSubmissionNotifyRequest(id, email);

    // recordSubmissionNotifySend's INSERT binds the same hash as its only value.
    const dbError = drizzleQueryError(
      'insert into "submission_notify_sends" ("email_hash") values ($1)',
      emailHash
    );
    expect(dbError.message).toContain(emailHash);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restoreInsert = failInsertsInto(submissionNotifySendsTable, dbError);

    try {
      const approved = await approveSubmission(id);
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      restoreInsert();

      expect(logged).toContain("notifySubmitterOfReview: record send failed");
      expect(logged).toContain("42P01");
      expect(logged).not.toContain(emailHash);
      expect(logged).not.toContain(email);

      // "Attempts, not outcomes," read the other way: an attempt that could
      // not be RECORDED must not be sent, because an unrecorded send is
      // exactly the uncapped-mail path the send cap exists to close.
      expect(approved.ok).toBe(true);
      if (approved.ok) expect(approved.facility.status).toBe("operational");
      expect(resendSendMock).not.toHaveBeenCalled();
      expect(await sendRowsFor(email)).toHaveLength(0);
      expect(await notifyRowsFor(id)).toHaveLength(0);
    } finally {
      restoreInsert();
      errorSpy.mockRestore();
    }
  });

  it("lookup failure (:280): logs a SQLSTATE, never the submission id, and returns before any send", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const email = "lookup-fails@example.com";
    const seedDoc = makeSeedDoc();
    const id = await seedStatusUpdateSubmission(seedDoc);
    await recordSubmissionNotifyRequest(id, email);

    // getSubmissionNotifyRequest's SELECT binds the submission's uuid — that is
    // the value a leaked DrizzleQueryError.message would carry here, so it is
    // what the fixture embeds and what must not reach the log.
    const dbError = drizzleQueryError(
      'select "email" from "submission_notify_requests" where "submission_id" = $1 limit $2',
      id
    );
    expect(dbError.message).toContain(id);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restoreSelect = failSelectsFrom(submissionNotifyRequestsTable, dbError);

    let approved: Awaited<ReturnType<typeof approveSubmission>>;
    try {
      approved = await approveSubmission(id);
    } finally {
      // Restored before any assertion: notifyRowsFor() selects from the very
      // table this patch makes throw.
      restoreSelect();
    }

    try {
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");

      expect(logged).toContain("notifySubmitterOfReview: lookup failed");
      expect(logged).toContain("42P01");
      expect(logged).not.toContain(id);
      expect(logged).not.toContain(email);
      // The marker of the leak itself: DrizzleQueryError's wrapper message.
      expect(logged).not.toContain("Failed query");

      // An unreadable request is treated as "unknown", not "absent": the
      // function returns immediately, so nothing is sent AND — unlike every
      // other site here — the row is deliberately NOT deleted, since deleting
      // an address we failed to read would destroy it on a transient DB error.
      expect(approved.ok).toBe(true);
      if (approved.ok) expect(approved.facility.status).toBe("operational");
      expect(resendSendMock).not.toHaveBeenCalled();
      expect(await sendRowsFor(email)).toHaveLength(0);
      expect(await notifyRowsFor(id)).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("delete failure (:331): logs a SQLSTATE, never the submission id, and leaves the row for a retry", async () => {
    // Flag OFF keeps the send block out of the picture entirely, so the delete
    // is the only statement that can fail on this run.
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "false");

    const email = "delete-fails@example.com";
    const seedDoc = makeSeedDoc();
    const id = await seedStatusUpdateSubmission(seedDoc);
    await recordSubmissionNotifyRequest(id, email);

    // deleteSubmissionNotifyRequest's DELETE binds the submission's uuid.
    const dbError = drizzleQueryError(
      'delete from "submission_notify_requests" where "submission_id" = $1',
      id
    );
    expect(dbError.message).toContain(id);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const restoreDelete = failDeletesFrom(submissionNotifyRequestsTable, dbError);

    let approved: Awaited<ReturnType<typeof approveSubmission>>;
    try {
      approved = await approveSubmission(id);
    } finally {
      restoreDelete();
    }

    try {
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");

      expect(logged).toContain("notifySubmitterOfReview: delete failed");
      expect(logged).toContain("42P01");
      expect(logged).not.toContain(id);
      expect(logged).not.toContain(email);
      expect(logged).not.toContain("Failed query");

      // A failed delete is the one case where the row survives review — the
      // address stays until the next successful delete. Pinned so a refactor
      // can't quietly turn the failure into a throw out of the review path.
      expect(approved.ok).toBe(true);
      if (approved.ok) expect(approved.facility.status).toBe("operational");
      expect(resendSendMock).not.toHaveBeenCalled();
      expect(await notifyRowsFor(id)).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("send failure (:318): logs the transport's error CODE, never the recipient address", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const email = "send-throws@example.com";
    const seedDoc = makeSeedDoc();
    const id = await seedStatusUpdateSubmission(seedDoc);
    await recordSubmissionNotifyRequest(id, email);

    // NOT a DrizzleQueryError: this site wraps a Resend call, so a SQLSTATE
    // fixture would be fiction. The real shape is an undici fetch failure —
    // `code` lives on `.cause`, which is exactly the layer redactedErrorCode
    // walks — and the message is where Resend echoes the recipient address back
    // (lib/email.ts already logs only `error.name` for that reason).
    const sendError = Object.assign(
      new TypeError(`fetch failed: POST https://api.resend.com/emails (to: ${email})`),
      { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) }
    );
    expect(sendError.message).toContain(email);
    contractViolation.sendSubmissionReviewedEmail = sendError;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const approved = await approveSubmission(id);
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");

      expect(logged).toContain("notifySubmitterOfReview: send failed");
      expect(logged).toContain("ECONNREFUSED");
      expect(logged).not.toContain(email);
      // The whole point: passing `err` as the second console.error argument is
      // enough to fail this, since String()-ing it yields the message above.
      expect(logged).not.toContain("api.resend.com");

      // "Attempts, not outcomes": the attempt was recorded BEFORE the send, so a
      // blown-up send still costs the address its budget, and the request row is
      // still deleted — a failed send does not earn a retry.
      expect(approved.ok).toBe(true);
      if (approved.ok) expect(approved.facility.status).toBe("operational");
      expect(await sendRowsFor(email)).toHaveLength(1);
      expect(await notifyRowsFor(id)).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("approve's outer catch (:170): a contract-violating throw is logged as a code, never the error object", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const email = "approve-outer@example.com";
    const seedDoc = makeSeedDoc();
    const id = await seedStatusUpdateSubmission(seedDoc);
    await recordSubmissionNotifyRequest(id, email);

    // Stands in for a DrizzleQueryError escaping from anywhere in the
    // notification subtree — the case the catch's own comment names. Binds the
    // submitter's plaintext address, the strongest thing to prove absent.
    const escaping = drizzleQueryError(
      'select "email" from "submission_notify_requests" where "submission_id" = $1',
      email
    );
    expect(escaping.message).toContain(email);
    contractViolation.submissionNotifyEnabled = escaping;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const approved = await approveSubmission(id);
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");

      // This site's own literal — no other catch in the file uses it.
      expect(logged).toContain("subscriber notification failed");
      expect(logged).toContain("42P01");
      expect(logged).not.toContain(email);
      expect(logged).not.toContain("Failed query");

      // The reason the catch exists: a notification failure never turns a
      // successful approval into an error response. The row survives, because
      // the throw preempts the unconditional delete — that is the cost of a
      // contract violation, not the normal contract.
      expect(approved.ok).toBe(true);
      if (approved.ok) expect(approved.facility.status).toBe("operational");
      expect(resendSendMock).not.toHaveBeenCalled();
      expect(await notifyRowsFor(id)).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("reject's outer catch (:214): a contract-violating throw is logged as a code, never the error object", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const email = "reject-outer@example.com";
    const id = await insertSubmission({
      kind: "create",
      payload: { name: "Outer Catch Reject Facility" },
    });
    await recordSubmissionNotifyRequest(id, email);

    const escaping = drizzleQueryError(
      'select "email" from "submission_notify_requests" where "submission_id" = $1',
      email
    );
    expect(escaping.message).toContain(email);
    contractViolation.submissionNotifyEnabled = escaping;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const rejected = await rejectSubmission(id, "couldn't verify from the cited source");
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");

      // Distinct from :170's literal, so neither test can be satisfied by the
      // other site's output.
      expect(logged).toContain("submitter notification failed");
      expect(logged).not.toContain("subscriber notification failed");
      expect(logged).toContain("42P01");
      expect(logged).not.toContain(email);
      expect(logged).not.toContain("Failed query");

      expect(rejected.ok).toBe(true);
      if (rejected.ok) expect(rejected.submission.status).toBe("rejected");
      expect(resendSendMock).not.toHaveBeenCalled();
      expect(await notifyRowsFor(id)).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
