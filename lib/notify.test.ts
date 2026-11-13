// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

import { eq } from "drizzle-orm";
vi.mock("@/lib/db/client");
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendChangeNotification: vi.fn().mockResolvedValue({ sent: true }),
  };
});

// Hoisted above the vi.mock factory below, which must reference it.
const { resendSendMock } = vi.hoisted(() => ({ resendSendMock: vi.fn() }));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { emailSendsTable, facilityHistoryTable, stateDigestRunsTable, subscriptionsTable } from "@/lib/db/schema";
import { generateToken, sendChangeNotification } from "@/lib/email";
import { stateNameFromCode } from "@/lib/us-states";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Imported after the mocks above so their transitive imports (lib/db/client,
// lib/email, resend) resolve against the mocked modules.
import {
  notifySubscribersOfChange,
  notifySubscribersOfChanges,
  notifyStateSubscribersMonthly,
  groupChangesByRecipient,
  sendGroupedChangeNotifications,
  NOTIFY_SEND_TIMEOUT_MS,
  sendGroupedChangeNotificationsUntil,
  type RecipientFacilityChange,
  type RecipientChangeGroup,
} from "@/lib/notify";
import { claimDigestWindow, STALE_DIGEST_RUN_MS, takeOverStaleDigestRun } from "@/lib/state-digest-ledger";

const facilitiesTyped = facilitiesRaw as unknown as Facility[];
const facilityA = facilitiesTyped[0];
const facilityB = facilitiesTyped.find((f) => f.id !== facilityA.id)!;
const facilityC = facilitiesTyped.find((f) => f.id !== facilityA.id && f.id !== facilityB.id)!;

// Theme D (state digest) fixtures: two facilities sharing one state, plus a
// facility in a different state, for asserting the digest stays scoped to a
// subscriber's own state.
const facilityTnA = facilitiesTyped[0]; // first fixture record (the "Tn" names are legacy; state is whatever it is)
const facilityTnB = facilitiesTyped.find(
  (f) => f.location.state === facilityTnA.location.state && f.id !== facilityTnA.id
)!;
const facilityOtherState = facilitiesTyped.find(
  (f) => f.location.state !== facilityTnA.location.state
)!;
const tnStateName = stateNameFromCode(facilityTnA.location.state)!;

// The email HTML escapes "&", and the fixture has a facility named "... Technology
// & Energy Center", so a raw-name toContain on html would never match it.
const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
});

beforeEach(async () => {
  await tdb.reset();
  vi.mocked(sendChangeNotification).mockClear();
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "digest-1" }, error: null });
  vi.stubEnv("RESEND_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await tdb.client.close();
});

type SubscriptionOverrides = {
  email?: string;
  targetType: "facility" | "state" | "all";
  targetId?: string | null;
  status?: "pending" | "confirmed" | "unsubscribed";
};

/** Inserts a subscription row directly (bypassing subscribeToTarget) with sensible defaults. */
async function insertSubscription(
  overrides: SubscriptionOverrides
): Promise<{ email: string; unsubscribeToken: string }> {
  const email = overrides.email ?? "reader@example.com";
  const unsubscribeToken = generateToken();
  await tdb.db.insert(subscriptionsTable).values({
    email,
    targetType: overrides.targetType,
    targetId: overrides.targetId ?? null,
    status: overrides.status ?? "confirmed",
    confirmToken: generateToken(),
    unsubscribeToken,
  });
  return { email, unsubscribeToken };
}

/** Inserts a facility_history row directly, for Theme D digest-query tests. */
async function insertHistoryRow(
  facilityId: string,
  changeType: "create" | "update" | "delete" | "editorial",
  changedAt: Date = new Date()
): Promise<void> {
  await tdb.db.insert(facilityHistoryTable).values({
    facilityId,
    changeType,
    changedAt,
    diff: [],
    source: "test",
  });
}

// ---------------------------------------------------------------------------
// groupChangesByRecipient — pure, no DB
// ---------------------------------------------------------------------------
describe("groupChangesByRecipient", () => {
  it("groups multiple changes for the same recipient into one group", () => {
    const changes: RecipientFacilityChange[] = [
      {
        origin: "facility-watch",
        email: "a@example.com",
        subscriptionId: "s1",
        unsubscribeToken: "t1",
        facilityName: "Facility A",
        facilitySlug: "a",
        changeLabel: "added to the atlas",
        status: "Operational",
      },
      {
        origin: "facility-watch",
        email: "a@example.com",
        subscriptionId: "s2",
        unsubscribeToken: "t2",
        facilityName: "Facility B",
        facilitySlug: "b",
        changeLabel: "record updated",
        status: "Permitted",
      },
    ];

    const groups = groupChangesByRecipient(changes);

    expect(groups).toHaveLength(1);
    expect(groups[0].email).toBe("a@example.com");
    expect(groups[0].changes).toHaveLength(2);
    expect(groups[0].changes.map((c) => c.facilitySlug)).toEqual(["a", "b"]);
  });

  it("keeps different recipients in separate groups", () => {
    const changes: RecipientFacilityChange[] = [
      {
        origin: "facility-watch",
        email: "a@example.com",
        subscriptionId: "s1",
        unsubscribeToken: "t1",
        facilityName: "Facility A",
        facilitySlug: "a",
        changeLabel: "added to the atlas",
        status: "Operational",
      },
      {
        origin: "facility-watch",
        email: "b@example.com",
        subscriptionId: "s2",
        unsubscribeToken: "t2",
        facilityName: "Facility A",
        facilitySlug: "a",
        changeLabel: "added to the atlas",
        status: "Operational",
      },
    ];

    const groups = groupChangesByRecipient(changes);

    expect(groups.map((g) => g.email).sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(groups.every((g) => g.changes.length === 1)).toBe(true);
  });

  it("returns an empty array for no changes", () => {
    expect(groupChangesByRecipient([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RecipientFacilityChange discriminated union — type-level pin for the
// `origin` refactor. Before this refactor, `stateName` was an optional field
// whose mere presence was the only signal for which email copy to send; a
// caller building a state-digest change could simply forget to set it and
// the object would compile fine (the exact defect this file's `origin`
// header comment documents). This test proves the mistake is now a compile
// error: `npm run typecheck` is the enforcement mechanism, and
// `@ts-expect-error` below is the assertion that the error is actually
// there — if a future edit widens `stateName` back to optional on the
// state-digest branch, this directive becomes "unused" and typecheck fails,
// which is the mutation-test signal for this exact regression (verified by
// hand: reverting `stateName` to optional and running `npm run typecheck`
// reports "Unused '@ts-expect-error' directive" at this line; restoring the
// required field makes it pass again).
// ---------------------------------------------------------------------------
/**
 * ⚠️ These two assert at COMPILE time, not run time. The `expect(...)` calls
 * below are deliberately vacuous — `npm test` alone can NEVER fail them. The
 * real gate is `npm run typecheck`: if the area fields ever become optional
 * again (or `origin` stops being required), the `@ts-expect-error` directives
 * become UNUSED and tsc errors on them. Verified by mutation: reverting
 * the area fields to optional produces "Unused '@ts-expect-error' directive" on
 * both, plus a genuine error where `sendAreaDigestEmail` receives a possibly
 * -undefined area field. Do not "fix" these into runtime assertions — the
 * constraint they pin is not observable at run time.
 */
describe("RecipientFacilityChange origin discriminator (type-level)", () => {
  it("rejects an origin: 'area-digest' change missing its area fields at compile time", () => {
    // @ts-expect-error — origin: "area-digest" requires areaType/areaId/areaName; omitting
    // it is the exact mistake the required `origin` discriminator exists to
    // make impossible to construct silently.
    const invalid: RecipientFacilityChange = {
      origin: "area-digest",
      email: "x@example.com",
      unsubscribeToken: "t",
      facilityName: "F",
      facilitySlug: "f",
      changeLabel: "record updated",
      status: "Operational",
    };
    expect(invalid).toBeDefined();
  });

  it("rejects an origin: 'facility-watch' change that carries area fields at compile time", () => {
    const invalid: RecipientFacilityChange = {
      origin: "facility-watch",
      email: "x@example.com",
      unsubscribeToken: "t",
      facilityName: "F",
      facilitySlug: "f",
      changeLabel: "record updated",
      status: "Operational",
      // @ts-expect-error — areaName does not exist on the facility-watch
      // branch; a facility-watch change must never carry area-digest-only
      // data.
      areaName: "Tennessee",
    };
    expect(invalid).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// notifySubscribersOfChange — existing single-facility path, unaffected
// ---------------------------------------------------------------------------
describe("notifySubscribersOfChange (single-facility — lib/submissions.ts:150's call path)", () => {
  it("still calls sendChangeNotification directly with the original per-facility shape", async () => {
    const sub = await insertSubscription({ targetType: "facility", targetId: facilityA.id });

    await notifySubscribersOfChange(facilityA, "record updated");

    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        email: sub.email,
        facilityName: facilityA.name,
        facilitySlug: facilityA.id,
        changeLabel: "record updated",
        unsubscribeToken: sub.unsubscribeToken,
      })
    );
    // A single-facility call never has more than one change per recipient,
    // so it must never take the multi-facility digest path.
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("sends each of two subscribers their own email, not a combined one", async () => {
    const subA = await insertSubscription({
      email: "a@example.com",
      targetType: "facility",
      targetId: facilityA.id,
    });
    const subB = await insertSubscription({
      email: "b@example.com",
      targetType: "facility",
      targetId: facilityA.id,
    });

    await notifySubscribersOfChange(facilityA, "record updated");

    expect(sendChangeNotification).toHaveBeenCalledTimes(2);
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ email: subA.email, unsubscribeToken: subA.unsubscribeToken })
    );
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ email: subB.email, unsubscribeToken: subB.unsubscribeToken })
    );
  });

  it("never throws when sendChangeNotification's underlying send fails", async () => {
    await insertSubscription({ targetType: "facility", targetId: facilityA.id });
    vi.mocked(sendChangeNotification).mockRejectedValueOnce(new Error("send failed"));

    await expect(notifySubscribersOfChange(facilityA, "record updated")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// notifySubscribersOfChanges — new batched notifier (scripts/sync-to-neon.ts)
// ---------------------------------------------------------------------------
describe("notifySubscribersOfChanges (batched, multi-facility)", () => {
  it("batches a recipient watching multiple changed facilities in one run into ONE email", async () => {
    const sub = await insertSubscription({ targetType: "facility", targetId: facilityA.id });
    await insertSubscription({
      email: sub.email,
      targetType: "facility",
      targetId: facilityB.id,
    });

    await notifySubscribersOfChanges([
      { facility: facilityA, changeLabel: "added to the atlas" },
      { facility: facilityB, changeLabel: "record updated" },
    ]);

    // The single-facility template must NOT fire for a multi-change recipient.
    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(resendSendMock).toHaveBeenCalledTimes(1);

    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe(sub.email);
    expect(args.html).toContain(facilityA.name);
    expect(args.html).toContain(facilityB.name);
    expect(args.text).toContain(facilityA.name);
    expect(args.text).toContain(facilityB.name);
  });

  it("sends the digest through the shared path with sender and one-click unsubscribe headers", async () => {
    // Hermetic: fromAddress() falls back to the default only when unset.
    vi.stubEnv("EMAIL_FROM", undefined);
    const sub = await insertSubscription({ targetType: "facility", targetId: facilityA.id });
    await insertSubscription({ email: sub.email, targetType: "facility", targetId: facilityB.id });

    await notifySubscribersOfChanges([
      { facility: facilityA, changeLabel: "added to the atlas" },
      { facility: facilityB, changeLabel: "record updated" },
    ]);

    const args = resendSendMock.mock.calls[0][0];
    expect(args.from).toBe("Compute Atlas <alerts@compute-atlas.com>");
    expect(args.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(args.headers["List-Unsubscribe"]).toMatch(/^<.*\/api\/subscribe\/unsubscribe\?token=.*&scope=all>$/);
  });

  it("pins the change digest log labels and no-key warning", async () => {
    const sub = await insertSubscription({ targetType: "facility", targetId: facilityA.id });
    await insertSubscription({ email: sub.email, targetType: "facility", targetId: facilityB.id });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const changes = [
      { facility: facilityA, changeLabel: "added to the atlas" },
      { facility: facilityB, changeLabel: "record updated" },
    ];

    resendSendMock.mockRejectedValueOnce(new TypeError("boom"));
    await notifySubscribersOfChanges(changes);
    expect(errSpy).toHaveBeenCalledWith("sendChangeDigestEmail failed:", "TypeError");

    vi.stubEnv("RESEND_API_KEY", "");
    await notifySubscribersOfChanges(changes);
    expect(warnSpy).toHaveBeenCalledWith("RESEND_API_KEY not set — skipping change digest email send");
  });

  it("gives each of multiple recipients their own single email", async () => {
    const subA = await insertSubscription({
      email: "a@example.com",
      targetType: "facility",
      targetId: facilityA.id,
    });
    const subB = await insertSubscription({
      email: "b@example.com",
      targetType: "facility",
      targetId: facilityB.id,
    });

    await notifySubscribersOfChanges([
      { facility: facilityA, changeLabel: "added to the atlas" },
      { facility: facilityB, changeLabel: "record updated" },
    ]);

    // Neither recipient has more than one change in this run, so both go
    // through the single-facility template, not the digest.
    expect(sendChangeNotification).toHaveBeenCalledTimes(2);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ email: subA.email, facilitySlug: facilityA.id })
    );
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ email: subB.email, facilitySlug: facilityB.id })
    );
  });

  it("does not notify lib/submissions.ts's caller path (targetType='facility' only, confirmed only) any differently", async () => {
    await insertSubscription({ targetType: "facility", targetId: facilityA.id, status: "pending" });
    await insertSubscription({ targetType: "state", targetId: facilityA.location.state, status: "confirmed" });

    await notifySubscribersOfChanges([{ facility: facilityA, changeLabel: "record updated" }]);

    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("never throws when the batched digest send fails", async () => {
    resendSendMock.mockRejectedValue(new Error("network failure"));
    const sub = await insertSubscription({ targetType: "facility", targetId: facilityA.id });
    await insertSubscription({
      email: sub.email,
      targetType: "facility",
      targetId: facilityB.id,
    });

    await expect(
      notifySubscribersOfChanges([
        { facility: facilityA, changeLabel: "added to the atlas" },
        { facility: facilityB, changeLabel: "record updated" },
      ])
    ).resolves.toBeUndefined();
  });

  it("is a no-op for an empty changes list (no facilities created/updated in a sync run)", async () => {
    await expect(notifySubscribersOfChanges([])).resolves.toBeUndefined();
    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("never leaks one recipient's address or facilities into another recipient's digest email", async () => {
    // subA watches A+B (2 changes → digest); subB watches B+C (2 changes →
    // digest). Both digests fire in the same run — each must contain ONLY
    // its own recipient's facilities, never the other's, and never the other
    // recipient's email address anywhere in the body.
    const subA = await insertSubscription({
      email: "a@example.com",
      targetType: "facility",
      targetId: facilityA.id,
    });
    await insertSubscription({ email: subA.email, targetType: "facility", targetId: facilityB.id });
    const subB = await insertSubscription({
      email: "b@example.com",
      targetType: "facility",
      targetId: facilityB.id,
    });
    await insertSubscription({ email: subB.email, targetType: "facility", targetId: facilityC.id });

    await notifySubscribersOfChanges([
      { facility: facilityA, changeLabel: "added to the atlas" },
      { facility: facilityB, changeLabel: "record updated" },
      { facility: facilityC, changeLabel: "record updated" },
    ]);

    expect(resendSendMock).toHaveBeenCalledTimes(2);
    const calls = resendSendMock.mock.calls.map((call) => call[0]);
    const forA = calls.find((c) => c.to === subA.email);
    const forB = calls.find((c) => c.to === subB.email);
    expect(forA).toBeDefined();
    expect(forB).toBeDefined();

    // subA's email: its own facilities only, never subB's facility or address.
    expect(forA.html).toContain(facilityA.name);
    expect(forA.html).toContain(facilityB.name);
    expect(forA.html).not.toContain(facilityC.name);
    expect(forA.text).not.toContain(facilityC.name);
    expect(forA.text).not.toContain(subB.email);
    expect(forA.html).not.toContain(subB.email);

    // subB's email: its own facilities only, never subA's facility or address.
    expect(forB.html).toContain(facilityB.name);
    expect(forB.html).toContain(facilityC.name);
    expect(forB.html).not.toContain(facilityA.name);
    expect(forB.text).not.toContain(facilityA.name);
    expect(forB.text).not.toContain(subA.email);
    expect(forB.html).not.toContain(subA.email);
  });
});

// ---------------------------------------------------------------------------
// targetType scoping, isolated from targetId collision (Theme D). Both the
// pre-existing lib/notify.integration.test.ts "state targeting is inert"
// tests AND this file's own line-294 batched-path test (pre-existing,
// untouched otherwise) insert a state subscription whose targetId is a
// 2-letter state code (e.g. "TN") and assert it doesn't match a facility
// whose id is a long slug (e.g. "xai-colossus-memphis-tn") — real, but that
// also means all of those tests would still pass even if the
// `eq(subscriptionsTable.targetType, "facility")` clause were deleted
// outright on EITHER entry point, since the mismatched targetId alone
// already excludes the row (confirmed by mutation-testing during Theme D —
// see the PR/report, both single-facility and batched). The two tests below
// isolate targetType as the ONLY discriminator, one per entry point, by
// deliberately setting a "state" row's targetId to a real facility id — an
// adversarial value no real state subscription would ever hold (a state
// code is always 2 letters), chosen specifically so each test can ONLY pass
// if the targetType filter itself is doing the excluding.
// ---------------------------------------------------------------------------
describe("targetType scoping (isolated from targetId collision)", () => {
  it("notifySubscribersOfChange: does NOT notify a confirmed 'state' subscriber even when its targetId is set to the facility's own id", async () => {
    await insertSubscription({
      email: "state-row@example.com",
      targetType: "state",
      targetId: facilityA.id,
      status: "confirmed",
    });

    await notifySubscribersOfChange(facilityA, "record updated");

    expect(sendChangeNotification).not.toHaveBeenCalled();
  });

  it("notifySubscribersOfChanges (batched): does NOT notify a confirmed 'state' subscriber even when its targetId is set to the facility's own id", async () => {
    await insertSubscription({
      email: "state-row-batched@example.com",
      targetType: "state",
      targetId: facilityA.id,
      status: "confirmed",
    });

    await notifySubscribersOfChanges([{ facility: facilityA, changeLabel: "record updated" }]);

    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Double opt-in enforcement — status='confirmed' only. Per Ed's standing
// invariant on subscriptionsTable (lib/db/schema.ts) and the existing
// lib/notify.integration.test.ts coverage of notifySubscribersOfChange, this
// is the single most important boundary in this file: pending (unconfirmed)
// and unsubscribed rows must never receive mail, through either entry point.
// ---------------------------------------------------------------------------
describe("double opt-in enforcement (status='confirmed' only)", () => {
  it("notifySubscribersOfChange excludes pending and unsubscribed subscribers", async () => {
    // Distinct emails per row — subscriptions_active_target_idx (a partial
    // unique index on email+target excluding 'unsubscribed' rows) forbids two
    // non-unsubscribed rows for the SAME email+target, so a pending and a
    // confirmed row can never coexist for one subscriber anyway.
    await insertSubscription({
      email: "pending@example.com",
      targetType: "facility",
      targetId: facilityA.id,
      status: "pending",
    });
    await insertSubscription({
      email: "gone@example.com",
      targetType: "facility",
      targetId: facilityA.id,
      status: "unsubscribed",
    });
    const confirmed = await insertSubscription({
      email: "confirmed@example.com",
      targetType: "facility",
      targetId: facilityA.id,
      status: "confirmed",
    });

    await notifySubscribersOfChange(facilityA, "record updated");

    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ email: confirmed.email })
    );
  });

  it("notifySubscribersOfChanges excludes pending and unsubscribed subscribers, including within a multi-facility run — while still notifying a confirmed one in the SAME run", async () => {
    // watcher@example.com is pending on A and unsubscribed on B — must
    // receive NOTHING even though both of this run's facilities matched
    // their (inert) subscriptions. confirmed@example.com is confirmed on C,
    // in the SAME call, and must still fire — proving the exclusion is
    // status-scoped, not a blanket "nothing sent this run" bug that would
    // pass this assertion even if the confirmed filter were dropped entirely.
    await insertSubscription({
      email: "watcher@example.com",
      targetType: "facility",
      targetId: facilityA.id,
      status: "pending",
    });
    await insertSubscription({
      email: "watcher@example.com",
      targetType: "facility",
      targetId: facilityB.id,
      status: "unsubscribed",
    });
    const confirmed = await insertSubscription({
      email: "confirmed@example.com",
      targetType: "facility",
      targetId: facilityC.id,
      status: "confirmed",
    });

    await notifySubscribersOfChanges([
      { facility: facilityA, changeLabel: "added to the atlas" },
      { facility: facilityB, changeLabel: "record updated" },
      { facility: facilityC, changeLabel: "record updated" },
    ]);

    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ email: confirmed.email, facilitySlug: facilityC.id })
    );
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// notifyStateSubscribersMonthly — Theme D. Its one caller
// (app/api/cron/state-digest) is wired but DISABLED: no `crons` entry in
// vercel.json and `STATE_DIGEST_ENABLED` unset. Covers the digest query itself
// (confirmed-state-only, since-bound, scoped to the subscriber's own state)
// and reuse of the existing grouping/send path. The half-open `until` bound
// and the route's auth/kill-switch live in
// app/api/cron/state-digest/route.integration.test.ts.
// ---------------------------------------------------------------------------
describe("notifyStateSubscribersMonthly (monthly state digest, D3a)", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  const until = new Date("2026-02-01T00:00:00Z");
  const withinPeriod = new Date("2026-01-15T00:00:00Z");
  const beforePeriod = new Date("2025-12-01T00:00:00Z");

  async function seedStateDigestRecipient() {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);
    await insertSubscription({
      email: "confirmed@example.com",
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });
  }

  it("pins the state digest failure log label", async () => {
    await seedStateDigestRecipient();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resendSendMock.mockRejectedValueOnce(new TypeError("boom"));

    await notifyStateSubscribersMonthly(since, until);

    expect(errSpy).toHaveBeenCalledWith("sendAreaDigestEmail failed:", "TypeError");
  });

  it("pins the state digest no-key warning text", async () => {
    await seedStateDigestRecipient();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("RESEND_API_KEY", "");

    await notifyStateSubscribersMonthly(since, until);

    expect(warnSpy).toHaveBeenCalledWith("RESEND_API_KEY not set — skipping area digest email send");
  });

  it("notifies only a confirmed state subscriber — not pending, not unsubscribed, not 'all'", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);

    await insertSubscription({
      email: "pending@example.com",
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "pending",
    });
    await insertSubscription({
      email: "gone@example.com",
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "unsubscribed",
    });
    await insertSubscription({ email: "allsub@example.com", targetType: "all", status: "confirmed" });
    const confirmed = await insertSubscription({
      email: "confirmed@example.com",
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });

    await notifyStateSubscribersMonthly(since, until);

    // Exactly one change for the one eligible recipient, but a state digest
    // NEVER uses the facility-watch single-record template — see the
    // "state-digest copy" describe block below for why.
    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(resendSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: confirmed.email })
    );
  });

  it("gives a subscriber watching 2 changed facilities in their state ONE grouped email, scoped to their own state (not a facility from another state)", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await seedFacility(tdb.db, facilityTnB);
    await seedFacility(tdb.db, facilityOtherState);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);
    await insertHistoryRow(facilityTnB.id, "create", withinPeriod);
    await insertHistoryRow(facilityOtherState.id, "update", withinPeriod); // distractor — different state

    const sub = await insertSubscription({
      email: "watcher@example.com",
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });

    await notifyStateSubscribersMonthly(since, until);

    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(resendSendMock).toHaveBeenCalledTimes(1);

    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe(sub.email);
    expect(args.html).toContain(facilityTnA.name);
    expect(args.html).toContain(escapeHtml(facilityTnB.name));
    expect(args.html).not.toContain(escapeHtml(facilityOtherState.name));
    expect(args.text).not.toContain(facilityOtherState.name);

    // Every digest email must carry a working unsubscribe link built from
    // the recipient's OWN raw unsubscribeToken.
    const expectedUnsubFragment = `token=${encodeURIComponent(sub.unsubscribeToken)}`;
    expect(args.html).toContain(expectedUnsubFragment);
    expect(args.text).toContain(expectedUnsubFragment);
  });

  it("a recipient with confirmed subscriptions to TWO different states gets TWO separate emails, each naming only its own state and carrying only its own unsubscribe token (security review, round 2)", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await seedFacility(tdb.db, facilityOtherState);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);
    await insertHistoryRow(facilityOtherState.id, "update", withinPeriod);

    const otherStateName = stateNameFromCode(facilityOtherState.location.state)!;
    const email = "multi-state@example.com";
    const subTn = await insertSubscription({
      email,
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });
    const subOther = await insertSubscription({
      email,
      targetType: "state",
      targetId: facilityOtherState.location.state,
      status: "confirmed",
    });

    await notifyStateSubscribersMonthly(since, until);

    expect(sendChangeNotification).not.toHaveBeenCalled();
    // NOT one merged email — two, one per subscription.
    expect(resendSendMock).toHaveBeenCalledTimes(2);

    const calls = resendSendMock.mock.calls.map((call) => call[0]);
    const tnEmail = calls.find((c) => c.html.includes(tnStateName));
    const otherEmail = calls.find((c) => c.html.includes(otherStateName));
    expect(tnEmail).toBeDefined();
    expect(otherEmail).toBeDefined();
    expect(tnEmail).not.toBe(otherEmail);

    // The TN email: only TN's facility, only TN's state name, only TN's token.
    expect(tnEmail.to).toBe(email);
    expect(tnEmail.html).toContain(facilityTnA.name);
    expect(tnEmail.html).not.toContain(facilityOtherState.name);
    expect(tnEmail.html).not.toContain(otherStateName);
    expect(tnEmail.html).toContain(`token=${encodeURIComponent(subTn.unsubscribeToken)}`);
    expect(tnEmail.html).not.toContain(`token=${encodeURIComponent(subOther.unsubscribeToken)}`);

    // The other state's email: only ITS facility, only ITS state name, only ITS token.
    expect(otherEmail.to).toBe(email);
    expect(otherEmail.html).toContain(facilityOtherState.name);
    expect(otherEmail.html).not.toContain(facilityTnA.name);
    expect(otherEmail.html).not.toContain(tnStateName);
    expect(otherEmail.html).toContain(`token=${encodeURIComponent(subOther.unsubscribeToken)}`);
    expect(otherEmail.html).not.toContain(`token=${encodeURIComponent(subTn.unsubscribeToken)}`);
  });

  it("excludes facility_history rows before the digest period's `since` bound", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", beforePeriod); // too old — must not appear

    await insertSubscription({
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });

    await notifyStateSubscribersMonthly(since, until);

    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("never throws when the underlying send fails", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);
    await insertSubscription({
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });
    // A state digest (even a single-change one) sends via sendAreaDigestEmail
    // -> resendSendMock, never sendChangeNotification — see the "state-digest
    // copy" describe block below.
    resendSendMock.mockRejectedValueOnce(new Error("send failed"));

    // Still never throws — and the swallowed failure is now VISIBLE: one change
    // was built, zero recipients were actually sent. Before the return value
    // existed, this was indistinguishable from a quiet month.
    await expect(notifyStateSubscribersMonthly(since, until)).resolves.toEqual({
      ok: true,
      changes: 1,
      groups: 1,
      recipients: 0,
    });
  });

  it("is a no-op when there are no confirmed state subscribers at all", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);

    await expect(notifyStateSubscribersMonthly(since, until)).resolves.toEqual({
      ok: true,
      changes: 0,
      groups: 0,
      recipients: 0,
    });
    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("excludes an 'editorial' (notes-only) history row from the digest", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "editorial", withinPeriod);
    await insertSubscription({
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });

    await expect(notifyStateSubscribersMonthly(since, until)).resolves.toEqual({
      ok: true,
      changes: 0,
      groups: 0,
      recipients: 0,
    });
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// State-digest copy correctness (team-lead review fix, Theme D). The SHAPE
// (grouping + send path) is shared with the facility-watch templates above;
// the COPY must not be, because a state-digest recipient never asked to be
// told about a specific record, and — critically — every change in a
// state-digest group shares ONE subscription row's unsubscribeToken, unlike
// a facility-watch group where each change is its own row/token.
// ---------------------------------------------------------------------------
describe("notifyStateSubscribersMonthly — state-digest copy correctness", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  const until = new Date("2026-02-01T00:00:00Z");
  const withinPeriod = new Date("2026-01-15T00:00:00Z");

  it("a single-change state digest does NOT use the facility-watch template or claim 'the record you're watching'", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);
    const sub = await insertSubscription({
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });

    await notifyStateSubscribersMonthly(since, until);

    // Never the per-facility single-record template.
    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(resendSendMock).toHaveBeenCalledTimes(1);

    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe(sub.email);
    // The exact false claim a facility-watch recipient's email makes, and a
    // state-digest recipient never asked for.
    expect(args.text).not.toContain("the record you're watching");
    expect(args.html).not.toContain("the record you're watching");
    // States the state and the cadence instead.
    expect(args.html).toContain(tnStateName);
    expect(args.text.toLowerCase()).toContain("monthly");
    expect(args.html.toLowerCase()).toContain("monthly");
  });

  it("a multi-change state digest names the state and contains exactly ONE unsubscribe link, never one per change", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await seedFacility(tdb.db, facilityTnB);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);
    await insertHistoryRow(facilityTnB.id, "create", withinPeriod);
    const sub = await insertSubscription({
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });

    await notifyStateSubscribersMonthly(since, until);

    const args = resendSendMock.mock.calls[0][0];
    expect(args.html).toContain(tnStateName);
    expect(args.subject).toContain(tnStateName);

    // Exactly one PER-TARGET unsubscribe link (the regex excludes the separate
    // `&scope=all` stop-all link) in each of html and text — not one per
    // changed facility (contrast the facility-watch digest test below, which
    // pins the OPPOSITE: one link per item).
    const htmlUnsubCount = (args.html.match(/\/api\/subscribe\/unsubscribe\?token=[^&"\s]*(?=["\s]|$)/g) ?? []).length;
    const textUnsubCount = (args.text.match(/\/api\/subscribe\/unsubscribe\?token=[^&"\s]*(?=["\s]|$)/g) ?? []).length;
    expect(htmlUnsubCount).toBe(1);
    expect(textUnsubCount).toBe(1);
    expect(args.html).toContain(`token=${encodeURIComponent(sub.unsubscribeToken)}`);
    // Never the facility-watch digest's per-item label — a state-digest link
    // unsubscribes from the whole state, not "this one" facility.
    expect(args.html).not.toContain("Unsubscribe from this one");
  });

  it("leaves the facility-watch multi-facility digest's copy unchanged: one unsubscribe link PER changed facility, each labelled 'unsubscribe from this one'", async () => {
    const sub = await insertSubscription({ targetType: "facility", targetId: facilityA.id });
    await insertSubscription({ email: sub.email, targetType: "facility", targetId: facilityB.id });

    await notifySubscribersOfChanges([
      { facility: facilityA, changeLabel: "added to the atlas" },
      { facility: facilityB, changeLabel: "record updated" },
    ]);

    const args = resendSendMock.mock.calls[0][0];
    expect(args.subject).toBe("2 updates on facilities you're watching — Compute Atlas");
    const htmlUnsubCount = (args.html.match(/\/api\/subscribe\/unsubscribe\?token=[^&"\s]*(?=["\s]|$)/g) ?? []).length;
    expect(htmlUnsubCount).toBe(2); // one per facility, unlike the state digest's one-total
    expect(args.html).toContain("Unsubscribe from this one");
  });
});

// ---------------------------------------------------------------------------
// notifyStateSubscribersMonthly — idempotency (D3, the send ledger). Every
// call now claims its (since, until) window in state_digest_runs BEFORE
// building or sending anything (lib/state-digest-ledger.ts) — see that
// table's doc comment in lib/db/schema.ts for the full contract. The
// claim/complete primitives themselves are covered directly in
// lib/state-digest-ledger.test.ts; this block covers the WIRING — that
// notifyStateSubscribersMonthly actually consults the ledger at the right
// points and reports the right thing when it does.
// ---------------------------------------------------------------------------
describe("notifyStateSubscribersMonthly — idempotency (D3)", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  const until = new Date("2026-02-01T00:00:00Z");
  const withinPeriod = new Date("2026-01-15T00:00:00Z");

  async function seedOneChangeOneSubscriber(): Promise<void> {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);
    await insertSubscription({
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });
  }

  it("sends once on the first call and refuses the second call for the SAME window without sending again", async () => {
    await seedOneChangeOneSubscriber();

    const first = await notifyStateSubscribersMonthly(since, until);
    expect(first).toEqual({ ok: true, changes: 1, groups: 1, recipients: 1 });
    expect(resendSendMock).toHaveBeenCalledTimes(1);

    const second = await notifyStateSubscribersMonthly(since, until);

    // The mock's call COUNT is the load-bearing assertion here — a
    // return-value-only check could pass even if the second call sent a
    // duplicate and merely mis-reported it.
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(second.ok).toBe(true);
    expect(second.changes).toBe(0);
    expect(second.groups).toBe(0);
    expect(second.recipients).toBe(0);
    expect(second.alreadyRun).toBeDefined();
    expect(second.alreadyRun?.completedAt).not.toBeNull();
  });

  it("sends for two DIFFERENT windows independently", async () => {
    await seedOneChangeOneSubscriber();
    const otherSince = new Date("2026-02-01T00:00:00Z");
    const otherUntil = new Date("2026-03-01T00:00:00Z");
    await insertHistoryRow(facilityTnA.id, "update", new Date("2026-02-15T00:00:00Z"));

    const first = await notifyStateSubscribersMonthly(since, until);
    const secondWindow = await notifyStateSubscribersMonthly(otherSince, otherUntil);

    expect(first.recipients).toBe(1);
    expect(secondWindow.recipients).toBe(1);
    expect(secondWindow.alreadyRun).toBeUndefined();
    expect(resendSendMock).toHaveBeenCalledTimes(2);
  });

  it("a CRASHED prior run (claimed, never completed) is still refused, and the result distinguishes it from a completed prior run", async () => {
    await claimDigestWindow(since, until); // simulates a run that claimed and then crashed
    await seedOneChangeOneSubscriber();

    const result = await notifyStateSubscribersMonthly(since, until);

    expect(resendSendMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      changes: 0,
      groups: 0,
      recipients: 0,
      alreadyRun: { startedAt: expect.any(Date), completedAt: null, recipients: null },
    });
  });

  it("records completion counts on the ledger row after a real run", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await seedFacility(tdb.db, facilityTnB);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);
    await insertHistoryRow(facilityTnB.id, "create", withinPeriod);
    await insertSubscription({
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });

    const result = await notifyStateSubscribersMonthly(since, until);

    const rows = await tdb.db.select().from(stateDigestRunsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].completedAt).not.toBeNull();
    expect(rows[0].changes).toBe(result.changes);
    expect(rows[0].groups).toBe(result.groups);
    expect(rows[0].recipients).toBe(result.recipients);
  });

  it("leaves the window claimed with completedAt still null when the completion write throws after a successful claim and send", async () => {
    await seedOneChangeOneSubscriber();
    // getDb() is called 4 times on the success path — claimDigestWindow,
    // buildStateDigestChanges, sendGroupedChangeNotifications (the send
    // gate's email_sends writes), completeDigestWindow, in that order. Let
    // the first three through to the real PGlite instance and make only the
    // FOURTH (the completion write) throw, so the claim and the send both
    // genuinely happen and only the completion record is what fails.
    vi.mocked(dbClient.getDb)
      .mockReturnValueOnce(tdb.db as never)
      .mockReturnValueOnce(tdb.db as never)
      .mockReturnValueOnce(tdb.db as never)
      .mockImplementationOnce(() => {
        throw new Error("ledger completion write failed");
      });

    const result = await notifyStateSubscribersMonthly(since, until);

    expect(result).toEqual({ ok: false, changes: 0, groups: 0, recipients: 0 });
    expect(resendSendMock).toHaveBeenCalledTimes(1); // the send DID happen before the throw

    const rows = await tdb.db.select().from(stateDigestRunsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].completedAt).toBeNull(); // claimed, never marked complete
  });

  it("propagates a non-unique-violation claim error rather than treating it as a successful claim", async () => {
    await seedOneChangeOneSubscriber();
    vi.mocked(dbClient.getDb).mockImplementationOnce(() => {
      throw new Error("connection refused");
    });

    const result = await notifyStateSubscribersMonthly(since, until);

    expect(result).toEqual({ ok: false, changes: 0, groups: 0, recipients: 0 });
    expect(resendSendMock).not.toHaveBeenCalled();
    const rows = await tdb.db.select().from(stateDigestRunsTable);
    expect(rows).toHaveLength(0); // never claimed — nothing to leak
  });
});

// ---------------------------------------------------------------------------
// The mixed-state guard, tested DIRECTLY. It is unreachable through every
// current caller — notifyStateSubscribersMonthly keys groups by (email, state),
// which makes a two-state group impossible to construct — and unreachable code
// with no test is exactly what a later refactor deletes as dead. What it
// prevents is not cosmetic: a merged digest labelled with one arbitrary state,
// carrying ONE unsubscribe token, whose per-item links would silently
// unsubscribe the reader from a whole state they did not choose to leave.
// sendGroupedChangeNotifications is exported for this test and no other reason.
// ---------------------------------------------------------------------------
describe("sendGroupedChangeNotifications — mixed-state guard", () => {
  function stateDigestChange(
    stateName: string,
    facility: Facility
  ): RecipientChangeGroup["changes"][number] {
    return {
      origin: "area-digest",
      areaType: "state",
      areaId: stateName,
      areaName: stateName,
      subscriptionId: "s1",
      unsubscribeToken: "unsub-token-sentinel",
      facilityName: facility.name,
      facilitySlug: facility.id,
      changeLabel: "record updated",
      status: "Operational",
    };
  }

  it("refuses to send a group spanning two states, and logs neither address nor token", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const group: RecipientChangeGroup = {
      email: "reader@example.com",
      changes: [
        stateDigestChange(tnStateName, facilityTnA),
        stateDigestChange("Texas", facilityOtherState),
      ],
    };

    const sent = await sendGroupedChangeNotifications([group]);

    expect(sent).toBe(0);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain("reader@example.com");
    expect(logged).not.toContain("unsub-token-sentinel");
    consoleError.mockRestore();
  });

  it("positive control: the identical group with ONE state DOES send", async () => {
    // Without this, "zero sends" above could be an artifact of the fixture
    // rather than proof the guard fired.
    const [row] = await tdb.db
      .insert(subscriptionsTable)
      .values({
        email: "reader@example.com",
        targetType: "state",
        targetId: facilityTnA.location.state,
        status: "confirmed",
        confirmToken: generateToken(),
        unsubscribeToken: "unsub-token-sentinel",
      })
      .returning();
    const group: RecipientChangeGroup = {
      email: "reader@example.com",
      changes: [
        { ...stateDigestChange(tnStateName, facilityTnA), subscriptionId: row.id },
        { ...stateDigestChange(tnStateName, facilityTnB), subscriptionId: row.id },
      ],
    };

    const claim = await claimDigestWindow(new Date("2026-03-01T00:00:00Z"), new Date("2026-04-01T00:00:00Z"));
    if (!claim.claimed) throw new Error("fixture window already claimed");
    const sent = await sendGroupedChangeNotifications([group], claim.runId);

    expect(sent).toBe(1);
    expect(resendSendMock).toHaveBeenCalledTimes(1);
  });
});

// A facility digest lists N distinct watch rows; the send gate must re-check
// every one of them, or a watch the reader just left is still mailed.
describe("sendGroupedChangeNotifications — facility digest covers every row", () => {
  it("skips the WHOLE digest, recording one skipped row, when one covered row was unsubscribed after the recipient query", async () => {
    const insert = async (facility: Facility, status: "confirmed" | "unsubscribed") => {
      const [row] = await tdb.db
        .insert(subscriptionsTable)
        .values({
          email: "many@example.com",
          targetType: "facility",
          targetId: facility.id,
          status,
          confirmToken: generateToken(),
          unsubscribeToken: generateToken(),
        })
        .returning();
      return row;
    };
    const rowA = await insert(facilityA, "confirmed");
    const rowB = await insert(facilityB, "unsubscribed");
    const change = (row: typeof rowA, facility: Facility): RecipientFacilityChange => ({
      origin: "facility-watch",
      subscriptionId: row.id,
      email: "many@example.com",
      unsubscribeToken: row.unsubscribeToken,
      facilityName: facility.name,
      facilitySlug: facility.id,
      changeLabel: "record updated",
      status: "Operational",
    });

    const sent = await sendGroupedChangeNotifications(
      groupChangesByRecipient([change(rowA, facilityA), change(rowB, facilityB)])
    );

    expect(sent).toBe(0);
    expect(resendSendMock).not.toHaveBeenCalled();
    const all = await tdb.db.select().from(emailSendsTable);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "facility_digest", outcome: "skipped_unconfirmed" });
  });
});

describe("sendGroupedChangeNotifications — state digest needs a run id", () => {
  it("refuses a state-digest group without a runId: logs a fixed message, sends nothing, writes no row", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const group: RecipientChangeGroup = {
      email: "reader@example.com",
      changes: [
        {
          origin: "area-digest",
          areaType: "state",
          areaId: facilityTnA.location.state,
          areaName: tnStateName,
          subscriptionId: "s1",
          unsubscribeToken: "tok",
          facilityName: facilityTnA.name,
          facilitySlug: facilityTnA.id,
          changeLabel: "record updated",
          status: "Operational",
        },
      ],
    };
    expect(await sendGroupedChangeNotifications([group])).toBe(0);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(await tdb.db.select().from(emailSendsTable)).toHaveLength(0);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("reader@example.com");
    consoleError.mockRestore();
  });
});

describe("sendGroupedChangeNotifications — digest anchor token", () => {
  it("the facility digest's List-Unsubscribe token is the anchor (first) row's token", async () => {
    const insert = async (facility: Facility, token: string) => {
      const [row] = await tdb.db
        .insert(subscriptionsTable)
        .values({
          email: "many@example.com",
          targetType: "facility",
          targetId: facility.id,
          status: "confirmed",
          confirmToken: generateToken(),
          unsubscribeToken: token,
        })
        .returning();
      return row;
    };
    const rowA = await insert(facilityA, "anchor-token");
    const rowB = await insert(facilityB, "second-token");
    const change = (row: typeof rowA, facility: Facility): RecipientFacilityChange => ({
      origin: "facility-watch",
      subscriptionId: row.id,
      email: "many@example.com",
      unsubscribeToken: row.unsubscribeToken,
      facilityName: facility.name,
      facilitySlug: facility.id,
      changeLabel: "record updated",
      status: "Operational",
    });
    vi.stubEnv("RESEND_API_KEY", "test-key");
    resendSendMock.mockResolvedValue({ data: { id: "m-1" }, error: null });
    await sendGroupedChangeNotifications(groupChangesByRecipient([change(rowA, facilityA), change(rowB, facilityB)]));
    const header = resendSendMock.mock.calls[0][0].headers["List-Unsubscribe"] as string;
    expect(header).toContain("token=anchor-token");
    expect(header).not.toContain("second-token");
    const [send] = await tdb.db.select().from(emailSendsTable);
    expect(send.subscriptionId).toBe(rowA.id);
    vi.unstubAllEnvs();
  });
});

// A-3 unit 8b: the mixed-group guard generalised to areaType + areaId.
describe("area digest — mixed-group guard and run id", () => {
  const change = (areaType: "county" | "metro", areaId: string, areaName: string) => ({
    origin: "area-digest" as const,
    areaType,
    areaId,
    areaName,
    subscriptionId: "s1",
    unsubscribeToken: "unsub-token-sentinel",
    facilityName: "F",
    facilitySlug: "f",
    changeLabel: "record updated",
    status: "Operational",
  });

  it("refuses a group mixing two counties (same areaType, different areaId), logging no address or token", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const claim = await claimDigestWindow(new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
    if (!claim.claimed) throw new Error("fixture");
    const group: RecipientChangeGroup = {
      email: "reader@example.com",
      changes: [change("county", "loudoun-va", "Loudoun County, VA"), change("county", "fairfax-va", "Fairfax County, VA")],
    };
    expect(await sendGroupedChangeNotifications([group], claim.runId)).toBe(0);
    expect(resendSendMock).not.toHaveBeenCalled();
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain("mixed multiple areas");
    expect(logged).not.toContain("reader@example.com");
    expect(logged).not.toContain("unsub-token-sentinel");
  });

  it("refuses a group whose changes share areaType and areaName and differ only in areaId", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const claim = await claimDigestWindow(new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
    if (!claim.claimed) throw new Error("fixture");
    const group: RecipientChangeGroup = {
      email: "reader@example.com",
      changes: [change("county", "washington-va", "Washington County"), change("county", "washington-nj", "Washington County")],
    };
    expect(await sendGroupedChangeNotifications([group], claim.runId)).toBe(0);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).toContain("mixed multiple areas");
  });

  it("refuses a county group without a run id", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const group: RecipientChangeGroup = {
      email: "reader@example.com",
      changes: [change("county", "loudoun-va", "Loudoun County, VA")],
    };
    expect(await sendGroupedChangeNotifications([group])).toBe(0);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).toContain("needs a run id");
  });
});

// Resend allows ~2 requests a second: an unpaced digest run lost one subscriber's mail to
// `rate_limit_exceeded` on 2026-11-01.
describe("sendGroupedChangeNotifications — pacing and rate-limit retry", () => {
  const seedGroups = async (n: number) => {
    const changes: RecipientFacilityChange[] = [];
    for (let i = 0; i < n; i++) {
      const [row] = await tdb.db
        .insert(subscriptionsTable)
        .values({
          email: `pace${i}@example.com`,
          targetType: "facility",
          targetId: facilityA.id,
          status: "confirmed",
          confirmToken: generateToken(),
          unsubscribeToken: generateToken(),
        })
        .returning();
      changes.push({
        origin: "facility-watch",
        subscriptionId: row.id,
        email: row.email,
        unsubscribeToken: row.unsubscribeToken,
        facilityName: facilityA.name,
        facilitySlug: facilityA.id,
        changeLabel: "record updated",
        status: "Operational",
      });
    }
    return groupChangesByRecipient(changes);
  };

  it("waits at least 500 ms between consecutive sends", async () => {
    const groups = await seedGroups(5);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const sent = await sendGroupedChangeNotifications(groups, undefined, { sleep });

    expect(sent).toBe(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    for (const [ms] of sleep.mock.calls) expect(ms).toBeGreaterThanOrEqual(500);
  });

  it("retries once after a rate limit; the second result is what counts", async () => {
    const [group] = await seedGroups(1);
    const sleep = vi.fn().mockResolvedValue(undefined);
    vi.mocked(sendChangeNotification)
      .mockResolvedValueOnce({ sent: false, errorCode: "rate_limit_exceeded" })
      .mockResolvedValueOnce({ sent: true, resendId: null });

    const sent = await sendGroupedChangeNotifications([group], undefined, { sleep });

    expect(sent).toBe(1);
    expect(sendChangeNotification).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
    const rows = await tdb.db.select().from(emailSendsTable);
    expect(rows.map((r) => r.outcome).sort()).toEqual(["error", "sent"]);
  });

  it("does not retry a second consecutive rate limit", async () => {
    const [group] = await seedGroups(1);
    const sleep = vi.fn().mockResolvedValue(undefined);
    vi.mocked(sendChangeNotification)
      .mockResolvedValueOnce({ sent: false, errorCode: "rate_limit_exceeded" })
      .mockResolvedValueOnce({ sent: false, errorCode: "rate_limit_exceeded" })
      .mockResolvedValue({ sent: true, resendId: null });

    const sent = await sendGroupedChangeNotifications([group], undefined, { sleep });

    expect(sent).toBe(0);
    expect(sendChangeNotification).toHaveBeenCalledTimes(2);
    const rows = await tdb.db.select().from(emailSendsTable);
    expect(rows.every((r) => r.outcome === "error" && r.errorCode === "rate_limit_exceeded")).toBe(true);
  });

  it("costs no pace for a send the gate skips", async () => {
    const groups = await seedGroups(2);
    await tdb.db.update(subscriptionsTable).set({ status: "unsubscribed" }).where(eq(subscriptionsTable.id, groups[0].changes[0].subscriptionId));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const sent = await sendGroupedChangeNotifications(groups, undefined, { sleep });

    expect(sent).toBe(1);
    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("re-reads the subscription through the gate before the retry", async () => {
    const [group] = await seedGroups(1);
    const subscriptionId = group.changes[0].subscriptionId;
    // The sleep before the retry is where the subscriber opts out.
    const sleep = vi.fn().mockImplementation(async () => {
      await tdb.db.update(subscriptionsTable).set({ status: "unsubscribed" }).where(eq(subscriptionsTable.id, subscriptionId));
    });
    vi.mocked(sendChangeNotification).mockResolvedValueOnce({ sent: false, errorCode: "rate_limit_exceeded" });

    const sent = await sendGroupedChangeNotifications([group], undefined, { sleep });

    expect(sent).toBe(0);
    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    const rows = await tdb.db.select().from(emailSendsTable);
    expect(rows.map((r) => r.outcome).sort()).toEqual(["error", "skipped_unconfirmed"]);
  });

  it("does not retry other send failures", async () => {
    const [group] = await seedGroups(1);
    vi.mocked(sendChangeNotification).mockResolvedValueOnce({ sent: false, errorCode: "validation_error" });

    const sent = await sendGroupedChangeNotifications([group], undefined, { sleep: vi.fn().mockResolvedValue(undefined) });

    expect(sent).toBe(0);
    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
  });
});

describe("sendGroupedChangeNotifications — per-send timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("abandons a hung send as send_timeout and does not retry it", async () => {
    const changes: RecipientFacilityChange[] = [];
    const [row] = await tdb.db
      .insert(subscriptionsTable)
      .values({
        email: "hang@example.com",
        targetType: "facility",
        targetId: facilityA.id,
        status: "confirmed",
        confirmToken: generateToken(),
        unsubscribeToken: generateToken(),
      })
      .returning();
    changes.push({
      origin: "facility-watch",
      subscriptionId: row.id,
      email: row.email,
      unsubscribeToken: row.unsubscribeToken,
      facilityName: facilityA.name,
      facilitySlug: facilityA.id,
      changeLabel: "record updated",
      status: "Operational",
    });
    vi.mocked(sendChangeNotification).mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = sendGroupedChangeNotifications(groupChangesByRecipient(changes), undefined, {
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    // The DB gate runs on real async I/O: wait until the send has been started, then expire its timer.
    for (let i = 0; i < 2000 && vi.mocked(sendChangeNotification).mock.calls.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    await vi.advanceTimersByTimeAsync(NOTIFY_SEND_TIMEOUT_MS);

    expect(await run).toBe(0);
    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    const rows = await tdb.db.select().from(emailSendsTable);
    expect(rows.map((r) => r.outcome)).toEqual(["error"]);
    expect(rows[0].errorCode).toBe("send_timeout");
    vi.mocked(sendChangeNotification).mockReset();
    vi.mocked(sendChangeNotification).mockResolvedValue({ sent: true, resendId: null });
  });
});

describe("digest deadline", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  const until = new Date("2026-02-01T00:00:00Z");
  const withinPeriod = new Date("2026-01-15T00:00:00Z");
  const sleep = () => vi.fn().mockResolvedValue(undefined);

  async function seedThreeRecipients() {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      await insertSubscription({ email, targetType: "state", targetId: facilityTnA.location.state });
    }
  }

  /** A clock that reads 0 for the first `k` calls and 1000 afterwards (one read per group). */
  const clockPastAfter = (k: number) => {
    let calls = 0;
    return () => (calls++ < k ? 0 : 1000);
  };

  it("stops starting groups at the deadline, leaves the window open and flags incomplete", async () => {
    await seedThreeRecipients();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await notifyStateSubscribersMonthly(since, until, {
      deadline: 500,
      now: clockPastAfter(2),
      sleep: sleep(),
    });

    expect(result).toEqual({ ok: true, changes: 3, groups: 3, recipients: 2, incomplete: true });
    expect(resendSendMock).toHaveBeenCalledTimes(2);
    const [run] = await tdb.db.select().from(stateDigestRunsTable);
    expect(run.completedAt).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      "notifyStateSubscribersMonthly: deadline reached, handled 2 of 3 groups, sent 2; window left incomplete"
    );
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain("@example.com");
  });

  it("completes the window when the deadline is never reached", async () => {
    await seedThreeRecipients();

    const result = await notifyStateSubscribersMonthly(since, until, {
      deadline: 500,
      now: () => 0,
      sleep: sleep(),
    });

    expect(result).toEqual({ ok: true, changes: 3, groups: 3, recipients: 3 });
    const [run] = await tdb.db.select().from(stateDigestRunsTable);
    expect(run.completedAt).not.toBeNull();
  });

  it("the approve-path wrapper never forwards a deadline: every group sends even with the clock far past", async () => {
    const changes: RecipientFacilityChange[] = [];
    for (let i = 0; i < 3; i++) {
      const sub = await insertSubscription({ email: `w${i}@example.com`, targetType: "facility", targetId: facilityA.id });
      const [row] = await tdb.db.select().from(subscriptionsTable).where(eq(subscriptionsTable.unsubscribeToken, sub.unsubscribeToken));
      changes.push({
        origin: "facility-watch",
        subscriptionId: row.id,
        email: row.email,
        unsubscribeToken: row.unsubscribeToken,
        facilityName: facilityA.name,
        facilitySlug: facilityA.id,
        changeLabel: "record updated",
        status: "Operational",
      });
    }
    const groups = groupChangesByRecipient(changes);
    // Control: the Until entry point with a past deadline DOES stop, so a leak into the wrapper would show here.
    const stopped = await sendGroupedChangeNotificationsUntil(groups, undefined, { sleep: sleep(), deadline: 1, now: () => 1000 });
    expect(stopped).toMatchObject({ sent: 0, handled: 0, stoppedEarly: true });
    // The wrapper takes no deadline option at all; Date.now() is far past 1, so a leaked deadline of 1 would stop it.
    expect(await sendGroupedChangeNotifications(groups, undefined, { sleep: sleep(), deadline: 1 } as never)).toBe(3);
  });
});

describe("notifyStateSubscribersMonthly — resuming an incomplete window", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  const until = new Date("2026-02-01T00:00:00Z");
  const sleep = () => vi.fn().mockResolvedValue(undefined);
  const clockPastAfter = (k: number) => {
    let calls = 0;
    return () => (calls++ < k ? 0 : 1000);
  };

  async function seedThree() {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", new Date("2026-01-15T00:00:00Z"));
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      await insertSubscription({ email, targetType: "state", targetId: facilityTnA.location.state });
    }
  }
  const ageRun = async (ms: number) => {
    await tdb.db.update(stateDigestRunsTable).set({ startedAt: new Date(Date.now() - ms) });
  };
  const partialRun = () =>
    notifyStateSubscribersMonthly(since, until, { deadline: 500, now: clockPastAfter(2), sleep: sleep() });

  it("resumes a stale partial run: sends exactly the remaining groups under the same run id, then completes", async () => {
    await seedThree();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await partialRun()).recipients).toBe(2);
    const [before] = await tdb.db.select().from(stateDigestRunsTable);
    await ageRun(STALE_DIGEST_RUN_MS + 60_000);

    const result = await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });

    expect(result).toEqual({ ok: true, changes: 3, groups: 3, recipients: 3, resumed: true, skipped: 2, ambiguous: 0 });
    expect(resendSendMock).toHaveBeenCalledTimes(3);
    const [run] = await tdb.db.select().from(stateDigestRunsTable);
    expect(run.id).toBe(before.id);
    expect(run.completedAt).not.toBeNull();
  });

  it("skips groups whose earlier attempt is still `attempted` (it may have been delivered)", async () => {
    await seedThree();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await partialRun();
    const rows = await tdb.db.select().from(emailSendsTable);
    await tdb.db.update(emailSendsTable).set({ outcome: "attempted", completedAt: null }).where(eq(emailSendsTable.id, rows[0].id));
    await ageRun(STALE_DIGEST_RUN_MS + 60_000);

    const result = await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });

    expect(result).toMatchObject({ skipped: 2, ambiguous: 1 });
    expect(resendSendMock).toHaveBeenCalledTimes(3);
    // Only the never-started group went out; the `attempted` one was not re-sent but still counts toward recipients.
    expect(result.recipients).toBe(3);
  });

  it("refuses to resume while the prior run is younger than the stale threshold", async () => {
    await seedThree();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await partialRun();
    await ageRun(STALE_DIGEST_RUN_MS - 60_000);

    const result = await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });

    expect(result.alreadyRun?.completedAt).toBeNull();
    expect(result.resumed).toBeUndefined();
    expect(resendSendMock).toHaveBeenCalledTimes(2);
  });

  it("still returns alreadyRun for a completed window, however old", async () => {
    await seedThree();
    await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });
    await ageRun(STALE_DIGEST_RUN_MS * 10);

    const result = await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });

    expect(result.alreadyRun?.completedAt).not.toBeNull();
    expect(resendSendMock).toHaveBeenCalledTimes(3);
  });

  it("concurrent takeover: exactly one caller wins", async () => {
    await seedThree();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await partialRun();
    await ageRun(STALE_DIGEST_RUN_MS + 60_000);
    const [run] = await tdb.db.select().from(stateDigestRunsTable);

    const wins = await Promise.all([takeOverStaleDigestRun(run.id), takeOverStaleDigestRun(run.id)]);

    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  // Rewrites the single final row of every send in the run, to stage each "what did the earlier attempt leave" case.
  const setFinalRows = async (outcome: string, errorCode: string | null) => {
    await tdb.db.update(emailSendsTable).set({ outcome, errorCode });
  };

  it("one email with two state subscriptions: only the group the earlier run did not send is sent on resume", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await seedFacility(tdb.db, facilityOtherState);
    await insertHistoryRow(facilityTnA.id, "update", new Date("2026-01-15T00:00:00Z"));
    await insertHistoryRow(facilityOtherState.id, "update", new Date("2026-01-15T00:00:00Z"));
    await insertSubscription({ email: "two@example.com", targetType: "state", targetId: facilityTnA.location.state });
    await insertSubscription({ email: "two@example.com", targetType: "state", targetId: facilityOtherState.location.state });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const partial = await notifyStateSubscribersMonthly(since, until, { deadline: 500, now: clockPastAfter(1), sleep: sleep() });
    expect(partial).toMatchObject({ groups: 2, recipients: 1, incomplete: true });
    await ageRun(STALE_DIGEST_RUN_MS + 60_000);

    const result = await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });

    expect(result).toEqual({ ok: true, changes: 2, groups: 2, recipients: 2, resumed: true, skipped: 1, ambiguous: 0 });
    expect(resendSendMock).toHaveBeenCalledTimes(2);
  });

  it("skips a send_timeout row (the abandoned call may still deliver) and counts it ambiguous", async () => {
    await seedThree();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await partialRun();
    await setFinalRows("error", "send_timeout");
    await ageRun(STALE_DIGEST_RUN_MS + 60_000);

    const result = await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });

    expect(result).toMatchObject({ resumed: true, skipped: 2, ambiguous: 2, recipients: 3 });
    expect(resendSendMock).toHaveBeenCalledTimes(3);
  });

  it("retries a final rate_limit_exceeded row, which proves the provider rejected the request", async () => {
    await seedThree();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await partialRun();
    await setFinalRows("error", "rate_limit_exceeded");
    await ageRun(STALE_DIGEST_RUN_MS + 60_000);

    const result = await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });

    expect(result).toMatchObject({ resumed: true, skipped: 0, ambiguous: 0, recipients: 3 });
    expect(resendSendMock).toHaveBeenCalledTimes(5);
  });

  it("skips an unknown error code as ambiguous", async () => {
    await seedThree();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await partialRun();
    await setFinalRows("error", "some_new_provider_error");
    await ageRun(STALE_DIGEST_RUN_MS + 60_000);

    const result = await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });

    expect(result).toMatchObject({ skipped: 2, ambiguous: 2 });
    expect(resendSendMock).toHaveBeenCalledTimes(3);
  });

  it("retries a skipped_* row (nothing was attempted)", async () => {
    await seedThree();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await partialRun();
    await setFinalRows("skipped_suppressed", null);
    await ageRun(STALE_DIGEST_RUN_MS + 60_000);

    const result = await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });

    expect(result).toMatchObject({ resumed: true, skipped: 0 });
    expect(resendSendMock).toHaveBeenCalledTimes(5);
  });

  it("uses the LATEST row per subscription: an older error followed by a sent row counts as sent", async () => {
    await seedThree();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await partialRun();
    const rows = await tdb.db.select().from(emailSendsTable);
    for (const r of rows) {
      await tdb.db.insert(emailSendsTable).values({
        kind: r.kind,
        emailHash: r.emailHash,
        subscriptionId: r.subscriptionId,
        runId: r.runId,
        outcome: "error",
        errorCode: "rate_limit_exceeded",
        createdAt: new Date(r.createdAt.getTime() - 5000),
      });
    }
    await ageRun(STALE_DIGEST_RUN_MS + 60_000);

    const result = await notifyStateSubscribersMonthly(since, until, { sleep: sleep() });

    expect(result).toMatchObject({ skipped: 2, ambiguous: 0 });
    expect(resendSendMock).toHaveBeenCalledTimes(3);
  });
});

describe("takeOverStaleDigestRun SQL guards", () => {
  const since = new Date("2026-03-01T00:00:00Z");
  const until = new Date("2026-04-01T00:00:00Z");
  const staleMs = 600_000;
  const now = new Date("2026-04-02T09:00:00Z");

  async function insertRun(startedAt: Date, completedAt: Date | null): Promise<string> {
    const [row] = await tdb.db
      .insert(stateDigestRunsTable)
      .values({ since, until, startedAt, completedAt })
      .returning({ id: stateDigestRunsTable.id });
    return row.id;
  }

  it("never takes over a completed run, even when the caller's own check is bypassed", async () => {
    const id = await insertRun(new Date(now.getTime() - 10 * staleMs), new Date(now.getTime() - 5 * staleMs));
    expect(await takeOverStaleDigestRun(id, staleMs, now)).toBe(false);
  });

  it("takes over only once started_at is strictly older than staleMs", async () => {
    const id = await insertRun(new Date(now.getTime() - staleMs + 1), null);
    expect(await takeOverStaleDigestRun(id, staleMs, now)).toBe(false);
    // Exactly staleMs old is NOT stale: the guard is a strict `<`.
    await tdb.db.update(stateDigestRunsTable).set({ startedAt: new Date(now.getTime() - staleMs) }).where(eq(stateDigestRunsTable.id, id));
    expect(await takeOverStaleDigestRun(id, staleMs, now)).toBe(false);
    await tdb.db.update(stateDigestRunsTable).set({ startedAt: new Date(now.getTime() - staleMs - 1) }).where(eq(stateDigestRunsTable.id, id));
    expect(await takeOverStaleDigestRun(id, staleMs, now)).toBe(true);
    // started_at was refreshed to `now`, so an immediate second takeover loses.
    expect(await takeOverStaleDigestRun(id, staleMs, now)).toBe(false);
  });
});
