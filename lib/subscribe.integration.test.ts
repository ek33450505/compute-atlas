// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendConfirmEmail: vi.fn().mockResolvedValue({ sent: true }),
  };
});

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { subscriptionsTable } from "@/lib/db/schema";
import { sendConfirmEmail } from "@/lib/email";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Imported after the mocks above so their transitive imports (lib/db/client,
// lib/email) resolve against the mocked modules.
import { subscribeToTarget, confirmSubscription, unsubscribeByToken } from "@/lib/subscribe";

const seedDoc = facilitiesRaw[0] as unknown as Facility; // xai-colossus-memphis-tn

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  vi.mocked(sendConfirmEmail).mockClear();
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
    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("reader@example.com"); // lowercased + trimmed
    expect(rows[0].targetType).toBe("facility");
    expect(rows[0].targetId).toBe(seedDoc.id);
    expect(rows[0].status).toBe("pending");
    expect(sendConfirmEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "reader@example.com", targetLabel: seedDoc.name })
    );
  });

  it("creates one pending subscription for a valid state target", async () => {
    const result = await subscribeToTarget(
      { email: "reader@example.com", targetType: "state", targetId: "tx" },
      "iphash-2"
    );

    expect(result.ok).toBe(true);
    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].targetType).toBe("state");
    expect(rows[0].targetId).toBe("TX"); // normalized uppercase
    expect(rows[0].status).toBe("pending");
    expect(sendConfirmEmail).toHaveBeenCalledWith(
      expect.objectContaining({ targetLabel: "Texas" })
    );
  });

  it("creates one pending subscription for the 'all' target", async () => {
    const result = await subscribeToTarget(
      { email: "reader@example.com", targetType: "all" },
      "iphash-3"
    );

    expect(result.ok).toBe(true);
    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].targetType).toBe("all");
    expect(rows[0].targetId).toBeNull();
    expect(sendConfirmEmail).toHaveBeenCalledWith(
      expect.objectContaining({ targetLabel: "all Compute Atlas updates" })
    );
  });

  it("honeypot: returns generic ok but inserts zero rows and sends no email", async () => {
    const result = await subscribeToTarget(
      { email: "spammer@example.com", targetType: "all", website: "http://spam.example" },
      "iphash-4"
    );

    expect(result.ok).toBe(true);
    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(0);
    expect(sendConfirmEmail).not.toHaveBeenCalled();
  });

  it("rejects an invalid email with a 400", async () => {
    const result = await subscribeToTarget(
      { email: "not-an-email", targetType: "all" },
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

  it("rejects an unknown state code with a 400 and inserts nothing", async () => {
    const result = await subscribeToTarget(
      { email: "reader@example.com", targetType: "state", targetId: "ZZ" },
      "iphash-7"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Unknown state");
    }
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
  });

  it("duplicate active subscribe: still returns generic ok, still only one active row, no second email", async () => {
    const input = { email: "reader@example.com", targetType: "all" as const };

    const first = await subscribeToTarget(input, "iphash-8");
    expect(first.ok).toBe(true);

    const second = await subscribeToTarget(input, "iphash-8");
    expect(second.ok).toBe(true);

    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(1);
    expect(sendConfirmEmail).toHaveBeenCalledTimes(1); // not re-sent on the dedup (23505) path
  });
});

describe("confirmSubscription", () => {
  it("flips a pending row to confirmed", async () => {
    await subscribeToTarget({ email: "reader@example.com", targetType: "all" }, "iphash-9");
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
    await subscribeToTarget({ email: "reader@example.com", targetType: "all" }, "iphash-10");
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
    await subscribeToTarget({ email: "reader@example.com", targetType: "all" }, "iphash-11");
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
    await subscribeToTarget({ email: "reader@example.com", targetType: "all" }, "iphash-12");
    const [row] = await tdb.db.select().from(subscriptionsTable);
    expect(row.status).toBe("pending");
    expect(row.confirmedAt).toBeNull();
  });
});
