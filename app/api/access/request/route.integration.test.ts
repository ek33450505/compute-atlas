// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

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
// phase. Mirrors app/api/subscribe/route's and app/api/contact/route's
// identical mock.
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
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { apiAccessGrantsTable, intakeAttemptsTable } from "@/lib/db/schema";
import { EMAIL_SEND_CAP_MAX, RATE_LIMIT_MAX, hashIp } from "@/lib/rate-limit";

// Imported after the mocks above so the mocked modules are in effect.
import { POST } from "./route";

function req(body: unknown, headers?: HeadersInit): Request {
  return new Request("http://localhost/api/access/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function flushAfter(): Promise<void> {
  await pendingAfter;
}

let tdb: TestDbHandle;

/**
 * Seeds `n` "access-request" attempt rows for a raw IP, pre-hashed the way the
 * route does. This is what the limiter counts — seeding `api_access_grants`
 * rows (as these tests used to) no longer affects it at all.
 */
async function seedAttempts(ip: string, n: number): Promise<void> {
  const submitterIpHash = hashIp(ip);
  for (let i = 0; i < n; i++) {
    await tdb.db.insert(intakeAttemptsTable).values({ surface: "access-request", submitterIpHash });
  }
}

/** Every attempt row for `ip` — the rows the limiter actually counts. */
async function attemptsFor(ip: string) {
  return tdb.db
    .select()
    .from(intakeAttemptsTable)
    .where(eq(intakeAttemptsTable.submitterIpHash, hashIp(ip)));
}

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
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

describe("POST /api/access/request", () => {
  it("stages a pending grant with 201, and sends nothing when RESEND_API_KEY is unset", async () => {
    const res = await POST(req({ email: "reader@example.com" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    await flushAfter();

    const rows = await tdb.db.select().from(apiAccessGrantsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("sends the magic-link email once RESEND_API_KEY is set", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");

    const res = await POST(req({ email: "reader@example.com" }));
    expect(res.status).toBe(201);
    await flushAfter();

    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe("reader@example.com");
  });

  it("rejects a malformed JSON body with 400", async () => {
    const badReq = new Request("http://localhost/api/access/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(badReq);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid email with 400 and writes nothing", async () => {
    const res = await POST(req({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(0);
  });

  it("honeypot: returns 201 ok but inserts zero rows and never sends", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const res = await POST(req({ email: "spammer@example.com", website: "spam" }));
    expect(res.status).toBe(201);
    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(0);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("rate-limits a 6th request from the same ip within the window", async () => {
    const ip = "203.0.113.10";
    // Seeds ATTEMPT rows, not grant rows: the limiter counts `intake_attempts`
    // now, because counting grants made every non-inserting path free — and on
    // THIS endpoint the non-inserting paths are the three generic-success ones
    // (see `checkIntakeRateLimit` in lib/rate-limit.ts).
    await seedAttempts(ip, RATE_LIMIT_MAX);

    const res = await POST(req({ email: "reader@example.com" }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(apiAccessGrantsTable);
    expect(rows).toHaveLength(0); // the 6th attempt must not have landed
  });

  it("buckets by cf-connecting-ip, not a spoofed leftmost x-forwarded-for", async () => {
    const trustedIp = "203.0.113.12";
    await seedAttempts(trustedIp, RATE_LIMIT_MAX);

    // A different leftmost x-forwarded-for entry on every request is exactly
    // what defeated the naive leftmost-x-forwarded-for extraction
    // lib/rate-limit.ts once had, in production (see lib/rate-limit.ts's
    // extractTrustedClientIp doc comment); cf-connecting-ip must still win.
    const res = await POST(
      req(
        { email: "reader@example.com" },
        { "x-forwarded-for": "198.51.100.8", "cf-connecting-ip": trustedIp }
      )
    );
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(apiAccessGrantsTable);
    expect(rows).toHaveLength(0); // the spoofed-XFF attempt must not have landed
  });

  it("does NOT count pre-existing grant rows — the cap counts attempts, not outcomes", async () => {
    const ip = "203.0.113.66";
    const ipHash = hashIp(ip);
    for (let i = 0; i < RATE_LIMIT_MAX + 3; i++) {
      await tdb.db.insert(apiAccessGrantsTable).values({
        email: `prior${i}@example.com`,
        status: "revoked",
        confirmToken: `prior-tok-${i}`,
        submitterIpHash: ipHash,
      });
    }
    const res = await POST(req({ email: "fresh@example.com" }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(201);
  });
});

describe("POST /api/access/request — the three generic-success paths all cost budget (Finding 1)", () => {
  // These are the paths that used to be entirely free, and they are exactly the
  // ones an attacker hits while email-bombing a single address: once the
  // victim's per-address send cap is full, every further request returned the
  // same generic `{ok:true}` AND cost nothing.

  it("counts a honeypot-tripping request", async () => {
    const ip = "198.51.100.81";
    const res = await POST(req({ email: "bot@example.com", website: "spam" }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(0);
    const attempts = await attemptsFor(ip);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].surface).toBe("access-request");
  });

  it("counts a request that is over the per-address send cap", async () => {
    const ip = "198.51.100.82";
    const email = "capped@example.com";
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) {
      await tdb.db.insert(apiAccessGrantsTable).values({
        email,
        status: "revoked",
        confirmToken: `cap-tok-${i}`,
        submitterIpHash: `unrelated-ip-${i}`,
      });
    }

    const res = await POST(req({ email }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(201); // the generic success — unchanged, deliberately
    expect(await res.json()).toEqual({ ok: true });
    // No new grant row (still just the cap-filling ones), but budget spent.
    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(EMAIL_SEND_CAP_MAX);
    expect(await attemptsFor(ip)).toHaveLength(1);
  });

  it("counts a request whose address already holds a pending grant", async () => {
    const ip = "198.51.100.83";
    const email = "already@example.com";
    await tdb.db.insert(apiAccessGrantsTable).values({
      email,
      status: "pending",
      confirmToken: "existing-tok",
      submitterIpHash: "unrelated-ip",
    });

    const res = await POST(req({ email }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(201);
    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(1); // no second row
    expect(await attemptsFor(ip)).toHaveLength(1);
  });

  it("counts a Zod-failing request and an unparseable body", async () => {
    const ip = "198.51.100.84";
    await POST(req({ email: "not-an-email" }, { "x-forwarded-for": ip }));
    await POST(
      new Request("http://localhost/api/access/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: "{not json",
      })
    );
    expect(await attemptsFor(ip)).toHaveLength(2);
  });

  it("counts a real new request exactly once — the same 1 unit as every refusal", async () => {
    const ip = "198.51.100.85";
    const res = await POST(req({ email: "reader@example.com" }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(201);
    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(1);
    expect(await attemptsFor(ip)).toHaveLength(1);
  });

  it("does NOT count an already-refused (429) request", async () => {
    const ip = "198.51.100.86";
    await seedAttempts(ip, RATE_LIMIT_MAX);
    const res = await POST(req({ email: "reader@example.com" }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(429);
    expect(await attemptsFor(ip)).toHaveLength(RATE_LIMIT_MAX);
  });

  it("refuses the 6th request whether the first five inserted or not", async () => {
    // Five generic-success-but-no-insert requests against one victim address.
    // Under the old grant-counting limiter these cost 1 unit total (only the
    // first inserted) and an attacker could keep going indefinitely.
    const ip = "198.51.100.87";
    const email = "victim@example.com";
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await POST(req({ email }, { "x-forwarded-for": ip }));
      expect(res.status).toBe(201);
    }
    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(1); // 1 insert, 4 dedup no-ops
    expect(await attemptsFor(ip)).toHaveLength(RATE_LIMIT_MAX);

    const sixth = await POST(req({ email }, { "x-forwarded-for": ip }));
    expect(sixth.status).toBe(429);
  });

  it("fails CLOSED with a 503 (not a 429) when the attempt cannot be recorded", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await tdb.client.exec(`ALTER TABLE "intake_attempts" RENAME TO "intake_attempts_hidden"`);
    try {
      const res = await POST(req({ email: "reader@example.com" }, { "x-forwarded-for": "198.51.100.88" }));
      expect(res.status).toBe(503);
      expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(0);
      const logged = consoleError.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("sqlstate: 42P01");
      expect(logged).not.toContain(hashIp("198.51.100.88"));
    } finally {
      await tdb.client.exec(`ALTER TABLE "intake_attempts_hidden" RENAME TO "intake_attempts"`);
      consoleError.mockRestore();
    }
  });
});

describe("POST /api/access/request — honeypot type symmetry (Finding 3)", () => {
  it.each([
    ["a number", 1],
    ["zero", 0],
    ["a boolean true", true],
    ["an object", { a: 1 }],
    ["a non-empty array", ["x"]],
  ])(
    "trips on %s even alongside an invalid email, answering the generic 201",
    async (_label, website) => {
      // `requestAccessGrant` used to run Zod FIRST and check the honeypot on the
      // parsed data, and `website` was typed `z.string().optional()` — so
      // `{"website":1,"email":"bad"}` answered 400 with `issues` while
      // `{"website":"x","email":"bad"}` answered a generic 201.
      const res = await POST(req({ email: "not-an-email", website }));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true });
      expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(0);
    }
  );

  it("does NOT trip on an empty-string honeypot — a real browser's hidden input still requests", async () => {
    const res = await POST(req({ email: "reader@example.com", website: "" }));
    expect(res.status).toBe(201);
    expect(await tdb.db.select().from(apiAccessGrantsTable)).toHaveLength(1);
  });
});
