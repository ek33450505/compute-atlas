// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { subscriptionsTable } from "@/lib/db/schema";
import { EMAIL_SEND_CAP_MAX, AUTO_CONFIRM_CAP_MAX, AUTO_CONFIRM_CAP_WINDOW_MS } from "@/lib/rate-limit";
import { hashToken, isHashedToken } from "@/lib/token-hash";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Imported after the mock above so its transitive import of lib/db/client
// resolves against the mocked module. subscribeToTarget no longer calls
// sendConfirmEmail directly (a prior security-review fix) — it hands back a
// `confirm` signal for the route to act on, so lib/email needs no mock here.
import {
  subscribeInputSchema,
  subscribeToTarget,
  confirmSubscription,
  unsubscribeByToken,
} from "@/lib/subscribe";

const facilitiesTyped = facilitiesRaw as unknown as Facility[];
const seedDoc = facilitiesTyped[0]; // xai-colossus-memphis-tn

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
  // subscribeToTarget resolves the target facility via getFacilityById ->
  // loadFacilities, which now gates on readsUseDatabase() (see
  // lib/db/client.ts) rather than hasDatabaseUrl() directly.
  vi.mocked(dbClient.readsUseDatabase).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
});

afterAll(async () => {
  await tdb.client.close();
});

// Shape-only validation (no DB): does this look like a subscribe request?
// Whether a "state" targetId is a REAL state code (uppercasing included) is a
// semantic check the schema doesn't do — that's subscribeToTarget's job,
// covered by the "valid state target" / "unknown state code" cases below.
describe("subscribeInputSchema", () => {
  it("accepts a valid state target", () => {
    const result = subscribeInputSchema.safeParse({
      email: "reader@example.com",
      targetType: "state",
      targetId: "tx",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid facility target", () => {
    const result = subscribeInputSchema.safeParse({
      email: "reader@example.com",
      targetType: "facility",
      targetId: "some-facility",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a targetType outside facility|state (e.g. the retired 'all')", () => {
    const result = subscribeInputSchema.safeParse({
      email: "reader@example.com",
      targetType: "all",
      targetId: "tx",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a state target with no targetId", () => {
    const result = subscribeInputSchema.safeParse({
      email: "reader@example.com",
      targetType: "state",
    });
    expect(result.success).toBe(false);
  });
});

describe("subscribeToTarget", () => {
  it("creates one pending subscription for a valid facility target", async () => {
    await seedFacility(tdb.db, seedDoc);

    const result = await subscribeToTarget({
      email: "Reader@Example.com",
      targetType: "facility",
      targetId: seedDoc.id,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirm).toEqual(
        expect.objectContaining({
          email: "reader@example.com",
          targetLabel: seedDoc.name,
          confirmToken: expect.any(String),
        })
      );
    }
    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("reader@example.com"); // lowercased + trimmed
    expect(rows[0].targetType).toBe("facility");
    expect(rows[0].targetId).toBe(seedDoc.id);
    expect(rows[0].status).toBe("pending");
    // Stored confirmToken is the sha256 hash, never the raw value handed back for the email.
    expect(isHashedToken(rows[0].confirmToken)).toBe(true);
    if (result.ok && result.confirm) {
      expect(rows[0].confirmToken).toBe(hashToken(result.confirm.confirmToken));
      expect(rows[0].confirmToken).not.toBe(result.confirm.confirmToken);
    }
  });

  it("creates one pending subscription for a valid state target, uppercasing a lowercase code", async () => {
    const result = await subscribeToTarget({
      email: "reader@example.com",
      targetType: "state",
      targetId: "tx",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirm).toEqual(
        expect.objectContaining({
          email: "reader@example.com",
          targetLabel: "Texas",
          confirmToken: expect.any(String),
        })
      );
    }
    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].targetType).toBe("state");
    expect(rows[0].targetId).toBe("TX"); // stored uppercase regardless of input casing
  });

  it("rejects an unknown state code with a 400 and inserts nothing", async () => {
    const result = await subscribeToTarget({
      email: "reader@example.com",
      targetType: "state",
      targetId: "zz",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Unknown state");
    }
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
  });

  it("rejects the 'all' target with a 400 (targetType is facility-only now)", async () => {
    const result = await subscribeToTarget({ email: "reader@example.com", targetType: "all" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid subscription");
    }
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
  });

  it("honeypot: returns generic ok but inserts zero rows and no confirm signal", async () => {
    const result = await subscribeToTarget({
      email: "spammer@example.com",
      targetType: "facility",
      targetId: "irrelevant-honeypot-tripped-first",
      website: "http://spam.example",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirm).toBeUndefined();
    }
    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(0);
  });

  it("rejects an invalid email with a 400", async () => {
    const result = await subscribeToTarget({
      email: "not-an-email",
      targetType: "facility",
      targetId: "some-facility",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid subscription");
    }
  });

  it("rejects an unknown facility target with a 400 and inserts nothing", async () => {
    const result = await subscribeToTarget({
      email: "reader@example.com",
      targetType: "facility",
      targetId: "does-not-exist",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Unknown facility");
    }
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
  });

  it("duplicate active subscribe: still returns generic ok, still only one active row, no second confirm signal", async () => {
    await seedFacility(tdb.db, seedDoc);
    const input = { email: "reader@example.com", targetType: "facility" as const, targetId: seedDoc.id };

    const first = await subscribeToTarget(input);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.confirm).toBeDefined();
    }

    const second = await subscribeToTarget(input);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.confirm).toBeUndefined(); // dedup (23505) path — no second confirm email
    }

    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(1);
  });

  it("per-email send cap: bounds confirm emails to one address across distinct targets", async () => {
    const email = "bombtarget@example.com";
    // EMAIL_SEND_CAP_MAX distinct valid facility targets so each call is a
    // genuinely new subscription (not deduped by the active-target unique
    // index) — isolates the per-email cap from the per-target dedup path.
    const targets = facilitiesTyped.slice(0, EMAIL_SEND_CAP_MAX + 1);
    expect(targets.length).toBe(EMAIL_SEND_CAP_MAX + 1);
    for (const doc of targets) {
      await seedFacility(tdb.db, doc);
    }

    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) {
      const result = await subscribeToTarget({ email, targetType: "facility", targetId: targets[i].id });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.confirm).toBeDefined(); // under the cap — real send scheduled
      }
    }

    const overCap = await subscribeToTarget({
      email,
      targetType: "facility",
      targetId: targets[EMAIL_SEND_CAP_MAX].id,
    });
    expect(overCap.ok).toBe(true);
    if (overCap.ok) {
      expect(overCap.confirm).toBeUndefined(); // over the per-address cap — generic success, no send
    }

    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(EMAIL_SEND_CAP_MAX); // the over-cap attempt created no row
  });
});

// Measured against prod Neon 2026-09-27: 9 of 14 pending rows belonged to
// addresses that already held a confirmed row elsewhere — this address never
// got to click a 2nd/3rd/4th confirm link because nobody clicks four. An
// address that already proved it receives our mail (a confirmed row, for ANY
// target) should never be asked to prove it again; an address that only has
// pending or unsubscribed rows has NOT proven that, and must stay on the
// ordinary double-opt-in path — see canAutoConfirm's doc comment
// in lib/subscribe.ts for the consent rationale.
describe("subscribeToTarget — auto-confirm for an address with a confirmed subscription elsewhere", () => {
  it("first-ever subscription for an address: row is pending, result carries confirm, no notice", async () => {
    await seedFacility(tdb.db, seedDoc);

    const result = await subscribeToTarget({
      email: "firsttimer@example.com",
      targetType: "facility",
      targetId: seedDoc.id,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirm).toBeDefined();
      expect(result.notice).toBeUndefined();
    }
    const [row] = await tdb.db.select().from(subscriptionsTable);
    expect(row.status).toBe("pending");
    expect(row.confirmedAt).toBeNull();
  });

  it("address with a CONFIRMED row elsewhere: new row is confirmed with confirmedAt set, notice not confirm", async () => {
    await seedFacility(tdb.db, seedDoc);
    const secondDoc = facilitiesTyped[1];
    await seedFacility(tdb.db, secondDoc);
    const email = "already-confirmed@example.com";

    // The fact under test — seeded directly, not produced via subscribe +
    // confirm, since this test is about what happens on the NEXT subscribe.
    await tdb.db.insert(subscriptionsTable).values({
      email,
      targetType: "facility",
      targetId: seedDoc.id,
      status: "confirmed",
      confirmedAt: new Date(),
      confirmToken: "seed-confirmed-tok",
      unsubscribeToken: "seed-confirmed-unsub",
    });

    const result = await subscribeToTarget({ email, targetType: "facility", targetId: secondDoc.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notice).toEqual(
        expect.objectContaining({ email, targetLabel: secondDoc.name, unsubscribeToken: expect.any(String) })
      );
      expect(result.confirm).toBeUndefined();
    }

    const rows = await tdb.db.select().from(subscriptionsTable).where(eq(subscriptionsTable.targetId, secondDoc.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("confirmed");
    expect(rows[0].confirmedAt).not.toBeNull();
    expect(rows[0].email).toBe(email);
  });

  it("address with only PENDING rows elsewhere: new subscription still pending, not auto-confirmed", async () => {
    await seedFacility(tdb.db, seedDoc);
    const secondDoc = facilitiesTyped[1];
    await seedFacility(tdb.db, secondDoc);
    const email = "only-pending@example.com";

    await tdb.db.insert(subscriptionsTable).values({
      email,
      targetType: "facility",
      targetId: seedDoc.id,
      status: "pending",
      confirmToken: "seed-pending-tok",
      unsubscribeToken: "seed-pending-unsub",
    });

    const result = await subscribeToTarget({ email, targetType: "facility", targetId: secondDoc.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirm).toBeDefined();
      expect(result.notice).toBeUndefined();
    }
    const rows = await tdb.db.select().from(subscriptionsTable).where(eq(subscriptionsTable.targetId, secondDoc.id));
    expect(rows[0].status).toBe("pending");
    expect(rows[0].confirmedAt).toBeNull();
  });

  // CONSENT GUARD: an unsubscribed row means this address already told us to
  // stop. Auto-confirming a new subscription for it would silently override
  // that opt-out with no click ever having happened on THIS target.
  it("address with only UNSUBSCRIBED rows elsewhere: NOT auto-confirmed — stays pending", async () => {
    await seedFacility(tdb.db, seedDoc);
    const secondDoc = facilitiesTyped[1];
    await seedFacility(tdb.db, secondDoc);
    const email = "opted-out@example.com";

    await tdb.db.insert(subscriptionsTable).values({
      email,
      targetType: "facility",
      targetId: seedDoc.id,
      status: "unsubscribed",
      unsubscribedAt: new Date(),
      confirmToken: "seed-unsub-tok",
      unsubscribeToken: "seed-unsub-unsub",
    });

    const result = await subscribeToTarget({ email, targetType: "facility", targetId: secondDoc.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirm).toBeDefined();
      expect(result.notice).toBeUndefined();
    }
    const rows = await tdb.db.select().from(subscriptionsTable).where(eq(subscriptionsTable.targetId, secondDoc.id));
    expect(rows[0].status).toBe("pending");
    expect(rows[0].confirmedAt).toBeNull();
  });
});

// H2 (security review, 2026-09-27): canAutoConfirm (then named
// hasConfirmedSubscription — renamed under H1 below once it grew a cap)
// previously ran with no try/catch around it, and neither subscribeToTarget
// nor the route catches around it either — a thrown DrizzleQueryError embeds
// its bound params (the subscriber's plaintext email) in `.message`, so an
// uncaught throw here would have reached Vercel Runtime Logs carrying it.
describe("canAutoConfirm — fails safe when the lookup itself throws (H2)", () => {
  // Simulates the lookup's own SELECT throwing, without touching the DB
  // schema: a column-rename/drop approach was tried and rejected first —
  // Drizzle's generated INSERT for this table explicitly lists EVERY column
  // (with `default` placeholders for ones not set), so breaking any single
  // column at the DDL level takes the insert down with it too, and this test
  // needs the insert to still succeed. Instead this patches `tdb.db.select`
  // to throw on exactly the SECOND `.select()` call made while resolving a
  // "state" target (the FIRST is checkEmailSendCap's own read, which must
  // keep working normally; a "state" target is used specifically so
  // getFacilityById never makes a third DB read). This is order-dependent on
  // subscribeToTarget's current sequencing (checkEmailSendCap, then
  // canAutoConfirm) — the same sequencing the security review asked to keep
  // unconditional and in place.
  it("a thrown lookup falls through to the ordinary pending/confirm path — never notice, never a throw — and logs no email address", async () => {
    const email = "flaky-lookup@example.com";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = tdb.db as unknown as { select: (...args: unknown[]) => unknown };
    const originalSelect = db.select.bind(tdb.db);
    let selectCalls = 0;
    db.select = (...args: unknown[]) => {
      selectCalls += 1;
      if (selectCalls === 2) {
        // A realistic transient-error shape (Postgres connection_failure),
        // not a bare Error — exercises redactedErrorCode's real-code path,
        // not just its "unknown" fallback.
        throw Object.assign(new Error("simulated read failure — connection reset"), { code: "08006" });
      }
      return originalSelect(...args);
    };

    try {
      const result = await subscribeToTarget({ email, targetType: "state", targetId: "tn" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.confirm).toBeDefined();
        expect(result.notice).toBeUndefined();
      }

      // Redacted like every other failure in this codebase: a discriminator
      // (the real sqlstate, not a placeholder), never the email.
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("canAutoConfirm");
      expect(logged).toContain("sqlstate: 08006");
      expect(logged).not.toContain(email);
    } finally {
      db.select = originalSelect;
      errorSpy.mockRestore();
    }

    const rows = await tdb.db.select().from(subscriptionsTable).where(eq(subscriptionsTable.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].confirmedAt).toBeNull();
  });
});

// H1 (security review, 2026-09-27): auto-confirm has a cumulative cap so an
// address can't have unlimited new subscriptions auto-confirmed in a burst.
// Ed's number: real power users top out around 8, so AUTO_CONFIRM_CAP_MAX=50
// is ~6x real usage. Going over the cap must NOT reject the subscription —
// it only denies the auto-confirm shortcut and falls back to pending+confirm.
describe("canAutoConfirm — cumulative cap: AUTO_CONFIRM_CAP_MAX confirmed rows per address per rolling window (H1)", () => {
  // `backdateMs` is a parameter (not baked in) specifically so the
  // window-duration test below can seed rows OUTSIDE the 7-day window,
  // while the boundary tests seed rows just outside checkEmailSendCap's
  // unrelated 1-hour/5-row window (lib/rate-limit.ts) — otherwise that cap
  // would trip first on 49-50 same-email rows and return the generic no-op
  // {ok:true} before subscribeToTarget ever reaches canAutoConfirm, which
  // would make those tests fail for the wrong reason.
  async function seedConfirmedRows(email: string, count: number, backdateMs: number): Promise<void> {
    const createdAt = new Date(Date.now() - backdateMs);
    for (let i = 0; i < count; i++) {
      await tdb.db.insert(subscriptionsTable).values({
        email,
        targetType: "state",
        targetId: `cap-test-${i}`,
        status: "confirmed",
        createdAt,
        confirmedAt: createdAt,
        confirmToken: `cap-tok-${i}`,
        unsubscribeToken: `cap-unsub-${i}`,
      });
    }
  }

  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

  it(`at ${AUTO_CONFIRM_CAP_MAX - 1} recent confirmed rows (one under the cap): still auto-confirms`, async () => {
    const email = "at-cap-minus-one@example.com";
    await seedConfirmedRows(email, AUTO_CONFIRM_CAP_MAX - 1, TWO_HOURS_MS);

    const result = await subscribeToTarget({ email, targetType: "state", targetId: "TX" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notice).toBeDefined();
      expect(result.confirm).toBeUndefined();
    }
    const rows = await tdb.db.select().from(subscriptionsTable).where(eq(subscriptionsTable.targetId, "TX"));
    expect(rows[0].status).toBe("confirmed");
  });

  it(`at exactly ${AUTO_CONFIRM_CAP_MAX} recent confirmed rows (at the cap): falls back to pending + confirm, does NOT reject`, async () => {
    const email = "at-cap@example.com";
    await seedConfirmedRows(email, AUTO_CONFIRM_CAP_MAX, TWO_HOURS_MS);

    const result = await subscribeToTarget({ email, targetType: "state", targetId: "TX" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirm).toBeDefined();
      expect(result.notice).toBeUndefined();
    }
    const rows = await tdb.db.select().from(subscriptionsTable).where(eq(subscriptionsTable.targetId, "TX"));
    expect(rows[0].status).toBe("pending");
    expect(rows[0].confirmedAt).toBeNull();
  });

  // Security review (2026-09-27, Medium): the two boundary tests above only
  // ever seed rows backdated a fixed 2 hours — which reads as "recent" under
  // ANY window from ~2 hours to infinity, so neither test exercises the
  // 7-day duration itself. Two DISTINCT regressions were named, and it takes
  // two DISTINCT tests to close both:
  //
  //  1. The `filter (...)` clause dropped entirely, silently turning the
  //     rolling cap into a lifetime cap (`recent` becomes `total`). Caught by
  //     the behavioral test below, which seeds rows OUTSIDE the window
  //     (derived from AUTO_CONFIRM_CAP_WINDOW_MS + 1 day, not a literal "8
  //     days", so it keeps working if the cap is ever deliberately retuned)
  //     and asserts they count toward `total` but not `recent`. If the filter
  //     is gone, `recent` jumps to match `total` regardless of any backdate
  //     value, so this test fails correctly no matter how the offset was
  //     computed.
  //  2. AUTO_CONFIRM_CAP_WINDOW_MS itself fat-fingered to the wrong duration.
  //     Tried first: deriving the behavioral test's backdate FROM this same
  //     constant (as done below, and as literally asked for, to survive a
  //     deliberate retune). Ran it as a live mutation test — set the constant
  //     to 90 days, reran: **all tests stayed green**, including this one.
  //     The reason is structural, not a fluke: the test's own offset
  //     (constant + 1 day) moves in lockstep with a fat-fingered constant, so
  //     it can never independently detect that the constant's value is
  //     wrong — the exact "asserting against an imported constant cannot
  //     fail" trap. The only fix is a test that pins the raw number against
  //     an INDEPENDENTLY written expectation, which is the dedicated test
  //     directly below this one.
  it("AUTO_CONFIRM_CAP_WINDOW_MS is exactly 7 days — pinned directly, independent of the constant's own value", () => {
    // Deliberately NOT derived from AUTO_CONFIRM_CAP_WINDOW_MS (see the long
    // comment above) — this is the one place that has to hardcode the
    // intended number, precisely so a fat-fingered edit to the constant has
    // something independent to disagree with.
    expect(AUTO_CONFIRM_CAP_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("confirmed rows older than the window count toward eligibility but not toward the cap (pins the filter behavior, not the raw duration — see AUTO_CONFIRM_CAP_WINDOW_MS test above for that)", async () => {
    const email = "outside-window@example.com";
    const outsideWindowMs = AUTO_CONFIRM_CAP_WINDOW_MS + 24 * 60 * 60 * 1000; // window + 1 day
    await seedConfirmedRows(email, AUTO_CONFIRM_CAP_MAX + 10, outsideWindowMs);

    const result = await subscribeToTarget({ email, targetType: "state", targetId: "TX" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notice).toBeDefined();
      expect(result.confirm).toBeUndefined();
    }
    const rows = await tdb.db.select().from(subscriptionsTable).where(eq(subscriptionsTable.targetId, "TX"));
    expect(rows[0].status).toBe("confirmed");
  });
});

// Follow-up to H2 (Ed, 2026-09-27): the pre-existing `throw err` for a
// genuine (non-duplicate) insert failure had the identical leak —
// DrizzleQueryError embeds bound params (the email) in `.message`, with no
// try/catch anywhere above this (app/api/subscribe/route.ts:125 doesn't wrap
// the call). Sanitized, not swallowed: the failure must still surface.
describe("subscribeToTarget — sanitizes a genuine (non-duplicate) insert failure instead of leaking it", () => {
  it("still rejects, logs a redacted discriminator, and the thrown error carries no email address", async () => {
    const email = "insert-fails@example.com";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = tdb.db as unknown as { insert: (...args: unknown[]) => unknown };
    const originalInsert = db.insert.bind(tdb.db);
    // Message deliberately embeds the email, mimicking a real
    // DrizzleQueryError's bound-params leak, so the mutation test (re-throw
    // the raw error) is actually caught by the "no email" assertion below.
    db.insert = () => ({
      values: () => {
        throw Object.assign(new Error(`simulated insert failure — params: ${email},state,TX`), {
          code: "08006",
        });
      },
    });

    let caught: unknown;
    try {
      try {
        await subscribeToTarget({ email, targetType: "state", targetId: "TX" });
        throw new Error("expected subscribeToTarget to reject, but it resolved");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      // Pins the exact sanitized message — if this fails because `caught` is
      // the "expected to reject" sentinel above, that means subscribeToTarget
      // did NOT reject, which is itself the regression this test also guards.
      expect((caught as Error).message).toBe("subscribeToTarget: insert failed");
      expect((caught as Error).message).not.toContain(email);

      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("subscribeToTarget insert failed");
      expect(logged).toContain("sqlstate: 08006");
      expect(logged).not.toContain(email);
    } finally {
      db.insert = originalInsert;
      errorSpy.mockRestore();
    }
  });
});

describe("confirmSubscription", () => {
  it("flips a pending row to confirmed", async () => {
    await seedFacility(tdb.db, seedDoc);
    const subscribeResult = await subscribeToTarget({
      email: "reader@example.com",
      targetType: "facility",
      targetId: seedDoc.id,
    });
    const rawToken = subscribeResult.ok && subscribeResult.confirm ? subscribeResult.confirm.confirmToken : "";
    const [row] = await tdb.db.select().from(subscriptionsTable);

    const result = await confirmSubscription(rawToken);
    expect(result.status).toBe("confirmed");

    const [updated] = await tdb.db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, row.id));
    expect(updated.status).toBe("confirmed");
    expect(updated.confirmedAt).not.toBeNull();
  });

  it("returns 'already' on a second confirm of the same token", async () => {
    await seedFacility(tdb.db, seedDoc);
    const subscribeResult = await subscribeToTarget({
      email: "reader@example.com",
      targetType: "facility",
      targetId: seedDoc.id,
    });
    const rawToken = subscribeResult.ok && subscribeResult.confirm ? subscribeResult.confirm.confirmToken : "";

    await confirmSubscription(rawToken);
    const second = await confirmSubscription(rawToken);
    expect(second.status).toBe("already");
  });

  it("returns 'invalid' for an unknown token and for an empty token", async () => {
    expect((await confirmSubscription("bogus-token")).status).toBe("invalid");
    expect((await confirmSubscription("")).status).toBe("invalid");
  });
});

describe("confirmSubscription — legacy raw-token dual-read", () => {
  it("confirms a pre-hashing row stored with a raw confirmToken, and upgrades it to a hash", async () => {
    await seedFacility(tdb.db, seedDoc);
    const rawLegacyToken = "legacy-raw-confirm-token-not-hashed";
    const [inserted] = await tdb.db
      .insert(subscriptionsTable)
      .values({
        email: "legacy@example.com",
        targetType: "facility",
        targetId: seedDoc.id,
        status: "pending",
        confirmToken: rawLegacyToken,
        unsubscribeToken: "legacy-unsub-token",
      })
      .returning({ id: subscriptionsTable.id });

    const result = await confirmSubscription(rawLegacyToken);
    expect(result.status).toBe("confirmed");

    const [updated] = await tdb.db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, inserted.id));
    expect(updated.status).toBe("confirmed");
    expect(isHashedToken(updated.confirmToken)).toBe(true);
    expect(updated.confirmToken).toBe(hashToken(rawLegacyToken));

    // The same raw link still works post-upgrade — a second confirm now hits
    // the hash-first path directly and correctly reports 'already'.
    const second = await confirmSubscription(rawLegacyToken);
    expect(second.status).toBe("already");
  });
});

describe("confirmSubscription — stolen-hash rejection", () => {
  it("rejects the stored hash itself as a presented token (closes the stolen-hash-as-bearer bypass)", async () => {
    await seedFacility(tdb.db, seedDoc);
    const subscribeResult = await subscribeToTarget({
      email: "reader@example.com",
      targetType: "facility",
      targetId: seedDoc.id,
    });
    const rawToken = subscribeResult.ok && subscribeResult.confirm ? subscribeResult.confirm.confirmToken : "";
    const [row] = await tdb.db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.email, "reader@example.com"));
    const stolenHash = row.confirmToken; // exactly what a DB leak would expose
    expect(isHashedToken(stolenHash)).toBe(true);
    expect(stolenHash).toBe(hashToken(rawToken));

    // Presenting the STOLEN HASH itself (never the raw token) must not authenticate.
    const result = await confirmSubscription(stolenHash);
    expect(result.status).toBe("invalid");

    // Untouched — the stolen hash never confirmed the row.
    const [unchanged] = await tdb.db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, row.id));
    expect(unchanged.status).toBe("pending");
    expect(unchanged.confirmedAt).toBeNull();

    // The genuine raw token still works — the guard doesn't break the real path.
    const genuine = await confirmSubscription(rawToken);
    expect(genuine.status).toBe("confirmed");
  });
});

describe("unsubscribeByToken", () => {
  it("flips a subscription to unsubscribed", async () => {
    await seedFacility(tdb.db, seedDoc);
    await subscribeToTarget({
      email: "reader@example.com",
      targetType: "facility",
      targetId: seedDoc.id,
    });
    const [row] = await tdb.db.select().from(subscriptionsTable);

    const result = await unsubscribeByToken(row.unsubscribeToken);
    expect(result.status).toBe("unsubscribed");

    const [updated] = await tdb.db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, row.id));
    expect(updated.status).toBe("unsubscribed");
    expect(updated.unsubscribedAt).not.toBeNull();
  });

  it("returns 'invalid' for an unknown token and for an empty token", async () => {
    expect((await unsubscribeByToken("bogus-token")).status).toBe("invalid");
    expect((await unsubscribeByToken("")).status).toBe("invalid");
  });
});

describe("double opt-in invariant", () => {
  it("a freshly subscribed row is 'pending', not 'confirmed', until confirmSubscription runs", async () => {
    await seedFacility(tdb.db, seedDoc);
    await subscribeToTarget({
      email: "reader@example.com",
      targetType: "facility",
      targetId: seedDoc.id,
    });
    const [row] = await tdb.db.select().from(subscriptionsTable);
    expect(row.status).toBe("pending");
    expect(row.confirmedAt).toBeNull();
  });
});
