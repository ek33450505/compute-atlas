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
import { EMAIL_SEND_CAP_MAX } from "@/lib/rate-limit";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Imported after the mock above so its transitive import of lib/db/client
// resolves against the mocked module. subscribeToTarget no longer calls
// sendConfirmEmail directly (Fix 1, s65 security review) — it hands back a
// `confirm` signal for the route to act on, so lib/email needs no mock here.
import { subscribeToTarget, confirmSubscription, unsubscribeByToken } from "@/lib/subscribe";

const facilitiesTyped = facilitiesRaw as unknown as Facility[];
const seedDoc = facilitiesTyped[0]; // xai-colossus-memphis-tn

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

describe("subscribeToTarget", () => {
  it("creates one pending subscription for a valid facility target", async () => {
    await seedFacility(tdb.db, seedDoc);

    const result = await subscribeToTarget(
      { email: "Reader@Example.com", targetType: "facility", targetId: seedDoc.id },
      "iphash-1"
    );

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
  });

  it("rejects a state target with a 400 (targetType is facility-only now)", async () => {
    const result = await subscribeToTarget(
      { email: "reader@example.com", targetType: "state", targetId: "tx" },
      "iphash-2"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid subscription");
    }
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
  });

  it("rejects the 'all' target with a 400 (targetType is facility-only now)", async () => {
    const result = await subscribeToTarget(
      { email: "reader@example.com", targetType: "all" },
      "iphash-3"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid subscription");
    }
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
  });

  it("honeypot: returns generic ok but inserts zero rows and no confirm signal", async () => {
    const result = await subscribeToTarget(
      {
        email: "spammer@example.com",
        targetType: "facility",
        targetId: "irrelevant-honeypot-tripped-first",
        website: "http://spam.example",
      },
      "iphash-4"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirm).toBeUndefined();
    }
    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(0);
  });

  it("rejects an invalid email with a 400", async () => {
    const result = await subscribeToTarget(
      { email: "not-an-email", targetType: "facility", targetId: "some-facility" },
      "iphash-5"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid subscription");
    }
  });

  it("rejects an unknown facility target with a 400 and inserts nothing", async () => {
    const result = await subscribeToTarget(
      { email: "reader@example.com", targetType: "facility", targetId: "does-not-exist" },
      "iphash-6"
    );

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

    const first = await subscribeToTarget(input, "iphash-8");
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.confirm).toBeDefined();
    }

    const second = await subscribeToTarget(input, "iphash-8");
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
      const result = await subscribeToTarget(
        { email, targetType: "facility", targetId: targets[i].id },
        `iphash-cap-${i}`
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.confirm).toBeDefined(); // under the cap — real send scheduled
      }
    }

    const overCap = await subscribeToTarget(
      { email, targetType: "facility", targetId: targets[EMAIL_SEND_CAP_MAX].id },
      "iphash-cap-over"
    );
    expect(overCap.ok).toBe(true);
    if (overCap.ok) {
      expect(overCap.confirm).toBeUndefined(); // over the per-address cap — generic success, no send
    }

    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(EMAIL_SEND_CAP_MAX); // the over-cap attempt created no row
  });
});

describe("confirmSubscription", () => {
  it("flips a pending row to confirmed", async () => {
    await seedFacility(tdb.db, seedDoc);
    await subscribeToTarget(
      { email: "reader@example.com", targetType: "facility", targetId: seedDoc.id },
      "iphash-9"
    );
    const [row] = await tdb.db.select().from(subscriptionsTable);

    const result = await confirmSubscription(row.confirmToken);
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
    await subscribeToTarget(
      { email: "reader@example.com", targetType: "facility", targetId: seedDoc.id },
      "iphash-10"
    );
    const [row] = await tdb.db.select().from(subscriptionsTable);

    await confirmSubscription(row.confirmToken);
    const second = await confirmSubscription(row.confirmToken);
    expect(second.status).toBe("already");
  });

  it("returns 'invalid' for an unknown token and for an empty token", async () => {
    expect((await confirmSubscription("bogus-token")).status).toBe("invalid");
    expect((await confirmSubscription("")).status).toBe("invalid");
  });
});

describe("unsubscribeByToken", () => {
  it("flips a subscription to unsubscribed", async () => {
    await seedFacility(tdb.db, seedDoc);
    await subscribeToTarget(
      { email: "reader@example.com", targetType: "facility", targetId: seedDoc.id },
      "iphash-11"
    );
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
    await subscribeToTarget(
      { email: "reader@example.com", targetType: "facility", targetId: seedDoc.id },
      "iphash-12"
    );
    const [row] = await tdb.db.select().from(subscriptionsTable);
    expect(row.status).toBe("pending");
    expect(row.confirmedAt).toBeNull();
  });
});
