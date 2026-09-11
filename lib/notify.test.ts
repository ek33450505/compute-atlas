// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

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
import { facilityHistoryTable, subscriptionsTable } from "@/lib/db/schema";
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
  type RecipientFacilityChange,
} from "@/lib/notify";

const facilitiesTyped = facilitiesRaw as unknown as Facility[];
const facilityA = facilitiesTyped[0];
const facilityB = facilitiesTyped.find((f) => f.id !== facilityA.id)!;
const facilityC = facilitiesTyped.find((f) => f.id !== facilityA.id && f.id !== facilityB.id)!;

// Theme D (state digest) fixtures: two facilities sharing one state, plus a
// facility in a different state, for asserting the digest stays scoped to a
// subscriber's own state.
const facilityTnA = facilitiesTyped[0]; // xai-colossus-memphis-tn, TN
const facilityTnB = facilitiesTyped.find(
  (f) => f.location.state === facilityTnA.location.state && f.id !== facilityTnA.id
)!;
const facilityOtherState = facilitiesTyped.find(
  (f) => f.location.state !== facilityTnA.location.state
)!;
const tnStateName = stateNameFromCode(facilityTnA.location.state)!; // "Tennessee"

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
  changeType: "create" | "update" | "delete",
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
        unsubscribeToken: "t1",
        facilityName: "Facility A",
        facilitySlug: "a",
        changeLabel: "added to the atlas",
        status: "Operational",
      },
      {
        origin: "facility-watch",
        email: "a@example.com",
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
        unsubscribeToken: "t1",
        facilityName: "Facility A",
        facilitySlug: "a",
        changeLabel: "added to the atlas",
        status: "Operational",
      },
      {
        origin: "facility-watch",
        email: "b@example.com",
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
 * real gate is `npm run typecheck`: if `stateName` ever becomes optional
 * again (or `origin` stops being required), the `@ts-expect-error` directives
 * become UNUSED and tsc errors on them. Verified by mutation: reverting
 * `stateName` to optional produces "Unused '@ts-expect-error' directive" on
 * both, plus a genuine error where `sendStateDigestEmail` receives a possibly
 * -undefined `stateName`. Do not "fix" these into runtime assertions — the
 * constraint they pin is not observable at run time.
 */
describe("RecipientFacilityChange origin discriminator (type-level)", () => {
  it("rejects an origin: 'state-digest' change missing stateName at compile time", () => {
    // @ts-expect-error — origin: "state-digest" requires stateName; omitting
    // it is the exact mistake the required `origin` discriminator exists to
    // make impossible to construct silently.
    const invalid: RecipientFacilityChange = {
      origin: "state-digest",
      email: "x@example.com",
      unsubscribeToken: "t",
      facilityName: "F",
      facilitySlug: "f",
      changeLabel: "record updated",
      status: "Operational",
    };
    expect(invalid).toBeDefined();
  });

  it("rejects an origin: 'facility-watch' change that carries stateName at compile time", () => {
    const invalid: RecipientFacilityChange = {
      origin: "facility-watch",
      email: "x@example.com",
      unsubscribeToken: "t",
      facilityName: "F",
      facilitySlug: "f",
      changeLabel: "record updated",
      status: "Operational",
      // @ts-expect-error — stateName does not exist on the facility-watch
      // branch; a facility-watch change must never carry state-digest-only
      // data.
      stateName: "Tennessee",
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
// notifyStateSubscribersMonthly — Theme D, D3a. Inert: nothing calls this
// function yet (D3b, the scheduled trigger, is out of scope). Covers the
// digest query itself (confirmed-state-only, since-bound, scoped to the
// subscriber's own state) and reuse of the existing grouping/send path.
// ---------------------------------------------------------------------------
describe("notifyStateSubscribersMonthly (monthly state digest, D3a)", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  const withinPeriod = new Date("2026-01-15T00:00:00Z");
  const beforePeriod = new Date("2025-12-01T00:00:00Z");

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

    await notifyStateSubscribersMonthly(since);

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

    await notifyStateSubscribersMonthly(since);

    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(resendSendMock).toHaveBeenCalledTimes(1);

    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe(sub.email);
    expect(args.html).toContain(facilityTnA.name);
    expect(args.html).toContain(facilityTnB.name);
    expect(args.html).not.toContain(facilityOtherState.name);
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

    await notifyStateSubscribersMonthly(since);

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

    await notifyStateSubscribersMonthly(since);

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
    // A state digest (even a single-change one) sends via sendStateDigestEmail
    // -> resendSendMock, never sendChangeNotification — see the "state-digest
    // copy" describe block below.
    resendSendMock.mockRejectedValueOnce(new Error("send failed"));

    await expect(notifyStateSubscribersMonthly(since)).resolves.toBeUndefined();
  });

  it("is a no-op when there are no confirmed state subscribers at all", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);

    await expect(notifyStateSubscribersMonthly(since)).resolves.toBeUndefined();
    expect(sendChangeNotification).not.toHaveBeenCalled();
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
  const withinPeriod = new Date("2026-01-15T00:00:00Z");

  it("a single-change state digest does NOT use the facility-watch template or claim 'the record you're watching'", async () => {
    await seedFacility(tdb.db, facilityTnA);
    await insertHistoryRow(facilityTnA.id, "update", withinPeriod);
    const sub = await insertSubscription({
      targetType: "state",
      targetId: facilityTnA.location.state,
      status: "confirmed",
    });

    await notifyStateSubscribersMonthly(since);

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

    await notifyStateSubscribersMonthly(since);

    const args = resendSendMock.mock.calls[0][0];
    expect(args.html).toContain(tnStateName);
    expect(args.subject).toContain(tnStateName);

    // Exactly one unsubscribe link in each of html and text — not one per
    // changed facility (contrast the facility-watch digest test below, which
    // pins the OPPOSITE: one link per item).
    const htmlUnsubCount = (args.html.match(/\/api\/subscribe\/unsubscribe\?token=/g) ?? []).length;
    const textUnsubCount = (args.text.match(/\/api\/subscribe\/unsubscribe\?token=/g) ?? []).length;
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
    const htmlUnsubCount = (args.html.match(/\/api\/subscribe\/unsubscribe\?token=/g) ?? []).length;
    expect(htmlUnsubCount).toBe(2); // one per facility, unlike the state digest's one-total
    expect(args.html).toContain("Unsubscribe from this one");
  });
});
