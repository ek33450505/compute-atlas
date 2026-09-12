// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

// `after()` throws "called outside a request scope" unless invoked inside a
// real Next.js request lifecycle, which this suite (calling POST directly)
// never sets up. Mocked to run the task immediately and capture its promise
// in `pendingAfter` so tests can deterministically await the email-send
// phase. Mirrors app/api/access/request/route's identical mock.
let pendingAfter: Promise<unknown> | undefined;
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      pendingAfter = Promise.resolve().then(task);
    },
  };
});

const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { subscribeAttemptsTable, subscriptionsTable } from "@/lib/db/schema";
import { EMAIL_SEND_CAP_MAX, hashIp, RATE_LIMIT_MAX } from "@/lib/rate-limit";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Imported after the mocks above so the mocked modules are in effect.
import { POST } from "./route";

const seedDoc = facilitiesRaw[0] as unknown as Facility; // xai-colossus-memphis-tn

function req(body: unknown, headers?: HeadersInit): Request {
  return new Request("http://localhost/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function flushAfter(): Promise<void> {
  await pendingAfter;
}

/** Rows in `subscribe_attempts` — the per-IP subscribe budget is spent by ATTEMPTS, not by successful inserts. */
async function countAttempts(): Promise<number> {
  return (await tdb.db.select().from(subscribeAttemptsTable)).length;
}

/** Seeds `n` prior attempt rows for `ipHash`, i.e. spends `n` units of that IP's budget. */
async function seedAttempts(ipHash: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await tdb.db.insert(subscribeAttemptsTable).values({ submitterIpHash: ipHash });
  }
}

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
  // subscribeToTarget resolves the target facility via getFacilityById ->
  // loadFacilities, which gates on readsUseDatabase() (see lib/db/client.ts)
  // rather than hasDatabaseUrl() directly.
  vi.mocked(dbClient.readsUseDatabase).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  pendingAfter = undefined;
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await tdb.client.close();
});

describe("POST /api/subscribe", () => {
  it("stages a pending subscription with 201, and sends nothing when RESEND_API_KEY is unset", async () => {
    await seedFacility(tdb.db, seedDoc);

    const res = await POST(req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    await flushAfter();

    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("sends the confirm email once RESEND_API_KEY is set", async () => {
    await seedFacility(tdb.db, seedDoc);
    vi.stubEnv("RESEND_API_KEY", "test-key");

    const res = await POST(req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }));
    expect(res.status).toBe(201);
    await flushAfter();

    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe("reader@example.com");
  });

  it("rejects a malformed JSON body with 400", async () => {
    const badReq = new Request("http://localhost/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(badReq);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid email with 400 and writes nothing", async () => {
    const res = await POST(req({ email: "not-an-email", targetType: "facility", targetId: seedDoc.id }));
    expect(res.status).toBe(400);
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
  });

  it("honeypot: returns 201 ok but inserts zero rows and never sends", async () => {
    await seedFacility(tdb.db, seedDoc);
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const res = await POST(
      req({ email: "spammer@example.com", targetType: "facility", targetId: seedDoc.id, website: "spam" })
    );
    expect(res.status).toBe(201);
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("rate-limits a 6th request from the same ip within the window", async () => {
    await seedFacility(tdb.db, seedDoc);
    const ip = "203.0.113.14";
    await seedAttempts(hashIp(ip), RATE_LIMIT_MAX);

    const res = await POST(
      req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }, { "x-forwarded-for": ip })
    );
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(0); // the 6th attempt must not have landed
  });

  it("buckets by cf-connecting-ip, not a spoofed leftmost x-forwarded-for", async () => {
    await seedFacility(tdb.db, seedDoc);
    const trustedIp = "203.0.113.15";
    await seedAttempts(hashIp(trustedIp), RATE_LIMIT_MAX);

    // A different leftmost x-forwarded-for entry on every request is exactly
    // what defeated the naive leftmost-x-forwarded-for extraction
    // lib/rate-limit.ts once had, in production (see lib/rate-limit.ts's
    // extractTrustedClientIp doc comment); cf-connecting-ip must still win.
    const res = await POST(
      req(
        { email: "reader@example.com", targetType: "facility", targetId: seedDoc.id },
        { "x-forwarded-for": "198.51.100.10", "cf-connecting-ip": trustedIp }
      )
    );
    expect(res.status).toBe(429);

    // The spoofed-XFF request landed in the TRUSTED ip's bucket, so it was
    // refused there — it did not get a fresh budget of its own.
    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(0); // the spoofed-XFF attempt must not have landed
  });
});

/**
 * The cap counts ATTEMPTS, not successful inserts. It previously counted
 * `subscriptions` rows, which only a successful INSERT can raise — so every
 * request that terminated without inserting was free and an attacker who never
 * succeeded was never limited.
 *
 * The property under test is stronger than "rejections are counted": EVERY
 * terminating path must write EXACTLY ONE attempt row, so no branch is
 * distinguishable from another by side effect. `subscribeToTarget` deliberately
 * returns an identical generic `{ok:true}` for the honeypot / duplicate /
 * over-cap paths, and the confirm email is sent after the response so latency
 * can't separate them either; a rate-limit write that fired on some of those
 * paths but not others would put the distinction straight back.
 */
describe("POST /api/subscribe — attempt accounting", () => {
  interface TerminatingPath {
    name: string;
    /** Runs against the already-seeded DB, before the measured request. */
    prepare?: () => Promise<void>;
    makeRequest: () => Request;
    expectedStatus: number;
    /**
     * Subscription rows the request is expected to add. Pins WHICH branch ran,
     * not just its status code — several distinct paths share `201`, and
     * without this the honeypot / over-cap / duplicate cases would still pass
     * if they had quietly fallen through to the insert.
     */
    expectedSubscriptionDelta: 0 | 1;
  }

  const terminatingPaths: TerminatingPath[] = [
    {
      name: "unparseable JSON body",
      makeRequest: () =>
        new Request("http://localhost/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{not valid json",
        }),
      expectedStatus: 400,
      expectedSubscriptionDelta: 0,
    },
    {
      name: "Zod-invalid email",
      makeRequest: () => req({ email: "not-an-email", targetType: "facility", targetId: seedDoc.id }),
      expectedStatus: 400,
      expectedSubscriptionDelta: 0,
    },
    {
      name: "missing targetId (Zod refine)",
      makeRequest: () => req({ email: "reader@example.com", targetType: "facility" }),
      expectedStatus: 400,
      expectedSubscriptionDelta: 0,
    },
    {
      name: "honeypot filled",
      makeRequest: () =>
        req({ email: "spammer@example.com", targetType: "facility", targetId: seedDoc.id, website: "spam" }),
      expectedStatus: 201,
      expectedSubscriptionDelta: 0,
    },
    {
      name: "unknown facility id",
      makeRequest: () => req({ email: "reader@example.com", targetType: "facility", targetId: "no-such-facility" }),
      expectedStatus: 400,
      expectedSubscriptionDelta: 0,
    },
    {
      name: "unknown state code",
      makeRequest: () => req({ email: "reader@example.com", targetType: "state", targetId: "ZZ" }),
      expectedStatus: 400,
      expectedSubscriptionDelta: 0,
    },
    {
      name: "over the per-address send cap",
      prepare: async () => {
        // Distinct targets, so the partial unique index doesn't fire first —
        // the send cap is what must terminate this request.
        for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) {
          await tdb.db.insert(subscriptionsTable).values({
            email: "capped@example.com",
            targetType: "facility",
            targetId: `other-facility-${i}`,
            status: "pending",
            confirmToken: `cap-tok-${i}`,
            unsubscribeToken: `cap-unsub-${i}`,
          });
        }
      },
      makeRequest: () => req({ email: "capped@example.com", targetType: "facility", targetId: seedDoc.id }),
      expectedStatus: 201,
      expectedSubscriptionDelta: 0,
    },
    {
      name: "duplicate of an existing active subscription",
      prepare: async () => {
        await tdb.db.insert(subscriptionsTable).values({
          email: "dupe@example.com",
          targetType: "facility",
          targetId: seedDoc.id,
          status: "pending",
          confirmToken: "dupe-tok",
          unsubscribeToken: "dupe-unsub",
        });
      },
      makeRequest: () => req({ email: "dupe@example.com", targetType: "facility", targetId: seedDoc.id }),
      expectedStatus: 201,
      expectedSubscriptionDelta: 0,
    },
    {
      name: "clean success",
      makeRequest: () => req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }),
      expectedStatus: 201,
      expectedSubscriptionDelta: 1,
    },
    {
      name: "state subscription success",
      makeRequest: () => req({ email: "reader@example.com", targetType: "state", targetId: "TN" }),
      expectedStatus: 201,
      expectedSubscriptionDelta: 1,
    },
  ];

  it.each(terminatingPaths)(
    "writes exactly one attempt row on the $name path",
    async ({ prepare, makeRequest, expectedStatus, expectedSubscriptionDelta }) => {
      await seedFacility(tdb.db, seedDoc);
      await prepare?.();

      const attemptsBefore = await countAttempts();
      const subscriptionsBefore = (await tdb.db.select().from(subscriptionsTable)).length;

      const res = await POST(makeRequest());
      expect(res.status).toBe(expectedStatus);
      await flushAfter();

      // Confirms the intended branch actually ran (several share a 201), so a
      // case can't pass by quietly falling through to the insert.
      expect((await tdb.db.select().from(subscriptionsTable)).length).toBe(
        subscriptionsBefore + expectedSubscriptionDelta
      );
      // The property itself: one request, one attempt row — whatever it did.
      expect(await countAttempts()).toBe(attemptsBefore + 1);
    }
  );

  it("attributes the attempt row to the trusted client ip's hash", async () => {
    await seedFacility(tdb.db, seedDoc);
    const ip = "203.0.113.22";

    await POST(
      req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }, { "cf-connecting-ip": ip })
    );

    const rows = await tdb.db.select().from(subscribeAttemptsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].submitterIpHash).toBe(hashIp(ip));
  });

  // THE DEFECT, stated as a test: this fails against the pre-fix implementation,
  // where the cap counted `subscriptions` rows and five rejections cost nothing.
  it("429s a 6th request even when all five prior requests were rejections that wrote no subscription", async () => {
    await seedFacility(tdb.db, seedDoc);
    const ip = "203.0.113.23";

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const rejected = await POST(
        req(
          { email: `attacker${i}@example.com`, targetType: "facility", targetId: "no-such-facility" },
          { "cf-connecting-ip": ip }
        )
      );
      expect(rejected.status).toBe(400);
    }
    // Not one of them inserted anything — that is precisely why they used to be free.
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);

    const res = await POST(
      req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }, { "cf-connecting-ip": ip })
    );
    expect(res.status).toBe(429);
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
  });

  // The refused request is the ONE path that must not record. Recording it
  // would mean the rolling window never drains under sustained traffic: a shared
  // IPv4 egress (CGNAT, corporate NAT, VPN, campus) would be locked out
  // indefinitely instead of for an hour, and a blocked client retrying would
  // extend its own block forever. Oracle-safe, because the 429 branch is decided
  // purely by the prior count — never by request content — and already announces
  // itself in the status code.
  it("does NOT record the already-refused 429 request, so the rolling window can drain", async () => {
    await seedFacility(tdb.db, seedDoc);
    const ip = "203.0.113.24";
    await seedAttempts(hashIp(ip), RATE_LIMIT_MAX);

    const res = await POST(
      req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }, { "cf-connecting-ip": ip })
    );
    expect(res.status).toBe(429);
    expect(await countAttempts()).toBe(RATE_LIMIT_MAX); // unchanged — the refusal cost nothing
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
  });

  // Both halves of the rate-limit accounting — the gate SELECT and the record
  // INSERT — bind the same ip hash and fail under the same conditions (42P01
  // when the migration has not been applied). Each must fail closed, answer 503
  // rather than 429, and keep the hash out of the log.
  // `break`/`restore` return the driver's result object, not void — typed
  // `Promise<unknown>` so tdb.client.exec() can be used point-free.
  //
  // `sqlstate` is the code the log must carry. Pinning the REAL code matters:
  // without it both cases pass just as happily if `redactedFailureCode` always
  // returned "unknown" — which is a false proxy, since "unknown" is exactly what
  // a redaction that extracted nothing would print. The code is the operator's
  // whole diagnostic (42P01 = the migration has not been applied), so asserting
  // it is asserting that redaction kept the useful half, not just dropped the
  // dangerous half.
  const accountingFailures: {
    name: string;
    sqlstate: string;
    break: () => Promise<unknown>;
    restore: () => Promise<unknown>;
  }[] = [
    {
      // Blocks INSERT while leaving SELECT working. NOT VALID skips the check
      // against existing rows, which is what makes it reversible.
      name: "the attempt INSERT fails",
      sqlstate: "23514", // check_violation
      break: () =>
        tdb.client.exec(
          `ALTER TABLE "subscribe_attempts" ADD CONSTRAINT tmp_block_inserts CHECK (false) NOT VALID`
        ),
      restore: () =>
        tdb.client.exec(`ALTER TABLE "subscribe_attempts" DROP CONSTRAINT tmp_block_inserts`),
    },
    {
      // Breaks the gate SELECT itself (42P01), which runs FIRST — the exact
      // "migration not applied" case the redaction exists for. With the gate
      // outside the try this throws uncaught, 500s, and Next logs the query
      // with the ip hash in its params.
      name: "the gate SELECT fails",
      sqlstate: "42P01", // undefined_table
      break: () =>
        tdb.client.exec(`ALTER TABLE "subscribe_attempts" RENAME TO "subscribe_attempts_hidden"`),
      restore: () =>
        tdb.client.exec(`ALTER TABLE "subscribe_attempts_hidden" RENAME TO "subscribe_attempts"`),
    },
  ];

  it.each(accountingFailures)(
    "fails closed with a 503 (not a 429) when $name, logging no ip hash",
    async ({ break: breakIt, sqlstate, restore }) => {
      await seedFacility(tdb.db, seedDoc);
      const ip = "203.0.113.26";

      await breakIt();
      // Spied AFTER breakIt(), deliberately: a throw from breakIt() skips the
      // finally below, and `clearMocks` only clears call history — it does not
      // restore an implementation — so the stub would leak into every later test
      // in this file and present as unrelated flakiness.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await POST(
          req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }, { "cf-connecting-ip": ip })
        );

        // An uncounted request must not be allowed to proceed...
        expect(res.status).toBe(503);
        // ...and an outage must not hide inside ordinary rate limiting, or a
        // deploy that precedes its migration looks like normal traffic shaping.
        expect(res.status).not.toBe(429);
        expect((await res.json()).error).toMatch(/temporarily unavailable/i);
        expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);

        // Logged — but with the ip hash redacted out. drizzle's DrizzleQueryError
        // embeds the bound params in its own `.message`, so logging the error
        // object would leak the pseudonymized IP into the log.
        const logged = errorSpy.mock.calls.flat().map(String).join(" ");
        expect(logged).toContain("subscribe rate-limit accounting failed");
        expect(logged).not.toContain(hashIp(ip));
        // The real SQLSTATE, not "unknown" — see the note on `sqlstate` above.
        expect(logged).toContain(`sqlstate: ${sqlstate}`);
      } finally {
        // mockRestore() FIRST: it is synchronous and cannot throw, whereas
        // restore() is DDL that can. Restoring the spy after it would re-open
        // the same leak the spy's placement above closes, by the other door.
        errorSpy.mockRestore();
        await restore();
      }
    }
  );

  // `hashIp` throws by design when CONTRIBUTE_IP_SALT is unset in production. It
  // used to sit OUTSIDE the try that carries the 503, so that one
  // misconfiguration was the single infrastructure failure here answered with an
  // uncaught 500 — i.e. a stack trace to the caller — while the comments claimed
  // all three were answered as infrastructure failures.
  it("fails closed with a 503 (not a 500) when CONTRIBUTE_IP_SALT is unset in production", async () => {
    await seedFacility(tdb.db, seedDoc);
    const ip = "203.0.113.27";
    vi.stubEnv("CONTRIBUTE_IP_SALT", undefined);
    vi.stubEnv("VERCEL_ENV", "production");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // If this rejects rather than resolving, that IS the regression: an
      // uncaught throw out of a route handler is Next's 500 path.
      const res = await POST(
        req(
          { email: "reader@example.com", targetType: "facility", targetId: seedDoc.id },
          { "cf-connecting-ip": ip }
        )
      );

      expect(res.status).toBe(503);
      expect(res.status).not.toBe(500);
      expect((await res.json()).error).toMatch(/temporarily unavailable/i);
      expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
      expect(await countAttempts()).toBe(0);

      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("subscribe rate-limit accounting failed");
      // Redacted like any other failure. A plain Error carries no `code`, hence
      // "unknown" — and crucially neither the thrown message nor the caller's IP
      // (which this path has in the clear, the hash having never been computed)
      // reaches the log.
      expect(logged).toContain("sqlstate: unknown");
      expect(logged).not.toContain("CONTRIBUTE_IP_SALT");
      expect(logged).not.toContain(ip);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("lets exactly RATE_LIMIT_MAX requests through before refusing, unchanged from the old counter", async () => {
    await seedFacility(tdb.db, seedDoc);
    const ip = "203.0.113.25";

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await POST(
        req(
          { email: `reader${i}@example.com`, targetType: "facility", targetId: seedDoc.id },
          { "cf-connecting-ip": ip }
        )
      );
      expect(res.status).toBe(201);
      await flushAfter();
    }

    const refused = await POST(
      req({ email: "sixth@example.com", targetType: "facility", targetId: seedDoc.id }, { "cf-connecting-ip": ip })
    );
    expect(refused.status).toBe(429);
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(RATE_LIMIT_MAX);
  });
});
