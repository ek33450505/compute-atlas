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
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { subscriptionsTable } from "@/lib/db/schema";
import { generateToken, sendChangeNotification } from "@/lib/email";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Imported after the mocks above so their transitive imports (lib/db/client,
// lib/email, resend) resolve against the mocked modules.
import {
  notifySubscribersOfChange,
  notifySubscribersOfChanges,
  groupChangesByRecipient,
  type RecipientFacilityChange,
} from "@/lib/notify";

const facilitiesTyped = facilitiesRaw as unknown as Facility[];
const facilityA = facilitiesTyped[0];
const facilityB = facilitiesTyped.find((f) => f.id !== facilityA.id)!;
const facilityC = facilitiesTyped.find((f) => f.id !== facilityA.id && f.id !== facilityB.id)!;

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

// ---------------------------------------------------------------------------
// groupChangesByRecipient — pure, no DB
// ---------------------------------------------------------------------------
describe("groupChangesByRecipient", () => {
  it("groups multiple changes for the same recipient into one group", () => {
    const changes: RecipientFacilityChange[] = [
      {
        email: "a@example.com",
        unsubscribeToken: "t1",
        facilityName: "Facility A",
        facilitySlug: "a",
        changeLabel: "added to the atlas",
        status: "Operational",
      },
      {
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
        email: "a@example.com",
        unsubscribeToken: "t1",
        facilityName: "Facility A",
        facilitySlug: "a",
        changeLabel: "added to the atlas",
        status: "Operational",
      },
      {
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
