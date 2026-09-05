// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { apiAccessGrantsTable } from "@/lib/db/schema";
import { EMAIL_SEND_CAP_MAX, checkAccessGrantRateLimit, checkAccessGrantEmailSendCap } from "@/lib/rate-limit";
import { hashToken, isHashedToken } from "@/lib/token-hash";

// Imported after the mock above so its transitive import of lib/db/client
// resolves against the mocked module. requestAccessGrant doesn't call
// sendBulkAccessEmail directly (mirrors subscribeToTarget's prior
// security-review fix) — it hands back a `confirm` signal for the route to act
// on, so lib/email needs no mock here.
import { requestAccessGrant, confirmAccessGrant } from "@/lib/access-grants";

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

describe("requestAccessGrant", () => {
  it("creates one pending grant for a valid email", async () => {
    const result = await requestAccessGrant({ email: "Reader@Example.com" }, "iphash-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirm).toEqual(
        expect.objectContaining({ email: "reader@example.com", confirmToken: expect.any(String) })
      );
    }

    const rows = await tdb.db.select().from(apiAccessGrantsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("reader@example.com"); // lowercased + trimmed
    expect(rows[0].status).toBe("pending");
    expect(rows[0].accessToken).toBeNull();
    // Stored confirmToken is the sha256 hash, never the raw value handed back for the email.
    expect(isHashedToken(rows[0].confirmToken)).toBe(true);
    if (result.ok && result.confirm) {
      expect(rows[0].confirmToken).toBe(hashToken(result.confirm.confirmToken));
      expect(rows[0].confirmToken).not.toBe(result.confirm.confirmToken);
    }
  });

  it("rejects an invalid email with a 400 and inserts nothing", async () => {
    const result = await requestAccessGrant({ email: "not-an-email" }, "iphash-2");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid request");
    }
    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(0);
  });

  it("honeypot: returns generic ok but inserts zero rows and no confirm signal", async () => {
    const result = await requestAccessGrant(
      { email: "spammer@example.com", website: "http://spam.example" },
      "iphash-3"
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirm).toBeUndefined();
    }
    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(0);
  });

  it("duplicate request for a pending email: still generic ok, still only one row, no second confirm signal", async () => {
    const input = { email: "reader@example.com" };

    const first = await requestAccessGrant(input, "iphash-4");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.confirm).toBeDefined();

    const second = await requestAccessGrant(input, "iphash-4");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.confirm).toBeUndefined(); // no leak, no second row

    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(1);
  });

  it("duplicate request for an already-active email: generic ok, no second row", async () => {
    const input = { email: "active@example.com" };
    const first = await requestAccessGrant(input, "iphash-5");
    const rawConfirm = first.ok && first.confirm ? first.confirm.confirmToken : "";
    await confirmAccessGrant(rawConfirm);

    const second = await requestAccessGrant(input, "iphash-5");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.confirm).toBeUndefined();

    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(1);
  });

  it("per-email send cap: bounds requests to one address, independent of the duplicate-grant dedup", async () => {
    const email = "bombtarget@example.com";
    // Revoke each newly created row immediately after it lands, so the next
    // iteration's duplicate-grant lookup (pending|active) finds nothing and
    // is forced through to the real per-email send-cap counter — otherwise
    // iterations 2+ would just hit the dedup no-op path and never exercise
    // the cap at all.
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) {
      const result = await requestAccessGrant({ email }, `iphash-cap-${i}`);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.confirm).toBeDefined(); // under the cap — real send scheduled
      // Filter to status='pending' — prior iterations' rows are already
      // revoked and would otherwise make this pick an arbitrary stale row
      // instead of the one this iteration just inserted.
      const [row] = await tdb.db
        .select()
        .from(apiAccessGrantsTable)
        .where(and(eq(apiAccessGrantsTable.email, email), eq(apiAccessGrantsTable.status, "pending")));
      await tdb.db
        .update(apiAccessGrantsTable)
        .set({ status: "revoked" })
        .where(eq(apiAccessGrantsTable.id, row.id));
    }

    const overCap = await requestAccessGrant({ email }, "iphash-cap-over");
    expect(overCap.ok).toBe(true);
    if (overCap.ok) {
      expect(overCap.confirm).toBeUndefined(); // over the per-address cap — generic success, no send
    }

    const rows = await tdb.db.select().from(apiAccessGrantsTable).where(eq(apiAccessGrantsTable.email, email));
    expect(rows).toHaveLength(EMAIL_SEND_CAP_MAX); // the over-cap attempt created no row
  });
});

describe("confirmAccessGrant", () => {
  it("flips a pending row to active and mints an accessToken", async () => {
    const requestResult = await requestAccessGrant({ email: "reader@example.com" }, "iphash-6");
    const rawConfirm = requestResult.ok && requestResult.confirm ? requestResult.confirm.confirmToken : "";
    const [row] = await tdb.db.select().from(apiAccessGrantsTable);

    const result = await confirmAccessGrant(rawConfirm);
    expect(result.status).toBe("active");
    if (result.status === "active") {
      expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }

    const [updated] = await tdb.db
      .select()
      .from(apiAccessGrantsTable)
      .where(eq(apiAccessGrantsTable.id, row.id));
    expect(updated.status).toBe("active");
    expect(updated.accessToken).not.toBeNull();
    expect(updated.confirmedAt).not.toBeNull();
    expect(updated.expiresAt).not.toBeNull();
    // Both tokens are stored as sha256 hashes, never the raw values returned to the caller.
    expect(isHashedToken(updated.confirmToken)).toBe(true);
    expect(isHashedToken(updated.accessToken!)).toBe(true);
    if (result.status === "active") {
      expect(updated.accessToken).toBe(hashToken(result.accessToken));
      expect(updated.accessToken).not.toBe(result.accessToken);
    }
  });

  it("is single-use: a second confirm of the same token is invalid and does not reissue a new accessToken", async () => {
    const requestResult = await requestAccessGrant({ email: "reader@example.com" }, "iphash-7");
    const rawConfirm = requestResult.ok && requestResult.confirm ? requestResult.confirm.confirmToken : "";
    const [row] = await tdb.db.select().from(apiAccessGrantsTable);

    const first = await confirmAccessGrant(rawConfirm);
    expect(first.status).toBe("active");
    const firstToken = first.status === "active" ? first.accessToken : null;

    const second = await confirmAccessGrant(rawConfirm);
    expect(second.status).toBe("invalid");

    const [updated] = await tdb.db
      .select()
      .from(apiAccessGrantsTable)
      .where(eq(apiAccessGrantsTable.id, row.id));
    // unchanged — no silent reissue. Stored value is the hash of the token minted on the first confirm.
    expect(updated.accessToken).toBe(hashToken(firstToken!));
  });

  it("returns 'invalid' for an unknown token and for an empty token", async () => {
    expect((await confirmAccessGrant("bogus-token")).status).toBe("invalid");
    expect((await confirmAccessGrant("")).status).toBe("invalid");
  });
});

describe("confirmAccessGrant — legacy raw-token dual-read", () => {
  it("confirms a pre-hashing row stored with a raw confirmToken, upgrades confirmToken to a hash, and stores the newly-minted accessToken hashed too", async () => {
    const rawLegacyToken = "legacy-raw-confirm-token-not-hashed";
    const [inserted] = await tdb.db
      .insert(apiAccessGrantsTable)
      .values({
        email: "legacy@example.com",
        status: "pending",
        confirmToken: rawLegacyToken,
      })
      .returning({ id: apiAccessGrantsTable.id });

    const result = await confirmAccessGrant(rawLegacyToken);
    expect(result.status).toBe("active");

    const [updated] = await tdb.db
      .select()
      .from(apiAccessGrantsTable)
      .where(eq(apiAccessGrantsTable.id, inserted.id));
    expect(updated.status).toBe("active");
    expect(isHashedToken(updated.confirmToken)).toBe(true);
    expect(updated.confirmToken).toBe(hashToken(rawLegacyToken));
    expect(isHashedToken(updated.accessToken!)).toBe(true);
    if (result.status === "active") {
      expect(updated.accessToken).toBe(hashToken(result.accessToken));
    }

    // Status is no longer 'pending', so a second confirm attempt (even
    // through the now-upgraded hash) reports invalid instead of reissuing —
    // same single-use guarantee as the non-legacy path.
    const second = await confirmAccessGrant(rawLegacyToken);
    expect(second.status).toBe("invalid");
  });
});

describe("confirmAccessGrant — stolen-hash rejection", () => {
  it("rejects the stored hash itself as a presented token (closes the stolen-hash-as-bearer bypass)", async () => {
    const requestResult = await requestAccessGrant({ email: "reader@example.com" }, "iphash-stolen-hash");
    const rawConfirm = requestResult.ok && requestResult.confirm ? requestResult.confirm.confirmToken : "";
    const [row] = await tdb.db.select().from(apiAccessGrantsTable);
    const stolenHash = row.confirmToken; // exactly what a DB leak would expose
    expect(isHashedToken(stolenHash)).toBe(true);
    expect(stolenHash).toBe(hashToken(rawConfirm));

    // Presenting the STOLEN HASH itself (never the raw token) must not authenticate.
    const result = await confirmAccessGrant(stolenHash);
    expect(result.status).toBe("invalid");

    // Untouched — still pending, no accessToken minted by the stolen hash.
    const [unchanged] = await tdb.db
      .select()
      .from(apiAccessGrantsTable)
      .where(eq(apiAccessGrantsTable.id, row.id));
    expect(unchanged.status).toBe("pending");
    expect(unchanged.accessToken).toBeNull();

    // The genuine raw token still works — the guard doesn't break the real path.
    const genuine = await confirmAccessGrant(rawConfirm);
    expect(genuine.status).toBe("active");
  });
});

describe("checkAccessGrantRateLimit", () => {
  it("blocks once RATE_LIMIT_MAX requests from the same IP land within the window", async () => {
    const ipHash = "rate-ip-1";
    for (let i = 0; i < 5; i++) {
      await tdb.db.insert(apiAccessGrantsTable).values({
        email: `user${i}@example.com`,
        status: "pending",
        confirmToken: `token-${i}`,
        submitterIpHash: ipHash,
      });
    }
    expect((await checkAccessGrantRateLimit(ipHash)).ok).toBe(false);
    expect((await checkAccessGrantRateLimit("other-ip")).ok).toBe(true);
  });
});

describe("checkAccessGrantEmailSendCap", () => {
  it("blocks once EMAIL_SEND_CAP_MAX rows exist for the same email within the window", async () => {
    const email = "capped@example.com";
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) {
      await tdb.db.insert(apiAccessGrantsTable).values({
        email,
        status: "pending",
        confirmToken: `cap-token-${i}`,
        submitterIpHash: `ip-${i}`,
      });
    }
    expect((await checkAccessGrantEmailSendCap(email)).ok).toBe(false);
    expect((await checkAccessGrantEmailSendCap("fresh@example.com")).ok).toBe(true);
  });
});
