// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import * as suppressions from "@/lib/suppressions";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { datasetAccessGrantsTable, emailSuppressionsTable } from "@/lib/db/schema";
import {
  EMAIL_SEND_CAP_MAX,
  RATE_LIMIT_WINDOW_MS,
  checkDatasetRequestEmailCap,
} from "@/lib/rate-limit";
import * as emailModule from "@/lib/email";
import { generateToken } from "@/lib/email";
import { hashToken } from "@/lib/token-hash";

// Imported after the mock above so its transitive import of lib/db/client
// resolves against the mocked module. None of these functions send mail: they
// hand back a `mail` intent for the caller to act on, so lib/email needs no mock.
import {
  DATASET_GRANT_TERM_MS,
  DATASET_ROTATION_COOLDOWN_MS,
  DATASET_TERMS_VERSION,
  DATASET_TOKEN_RE,
  DATASET_VERIFY_TTL_MS,
  approveDatasetGrant,
  expireDueGrants,
  extendDatasetGrant,
  getGrantByAccessToken,
  issueRenewalToken,
  reissueDatasetLink,
  redirectDatasetGrantToPaid,
  rejectDatasetGrant,
  requestDatasetAccess,
  requestRenewal,
  revokeDatasetGrant,
  verifyDatasetRequest,
} from "@/lib/dataset-grants";

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

const body = (over: Record<string, unknown> = {}) => ({
  email: "Reporter@Example.com",
  name: "Pat Reporter",
  organization: "The Gazette",
  role: "Data editor",
  category: "journalist",
  intendedUse: "Cross-checking siting announcements for a story.",
  links: ["https://example.com/story"],
  attributionAck: true,
  termsAccepted: true,
  ...over,
});

let seedCounter = 0;
async function insertGrant(over: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}) {
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: "reporter@example.com",
      name: "Seed",
      category: "journalist",
      intendedUse: "seed",
      attributionAckAt: new Date(),
      termsVersion: "seed-terms",
      verifyTokenHash: hashToken(`seed-verify-${seedCounter++}`),
      ...over,
    })
    .returning();
  return row;
}

const allRows = () => tdb.db.select().from(datasetAccessGrantsTable);

/** A date `n` days from now (negative: in the past). */
const daysFromNow = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

/** A `createdAt` safely older than the rotation cooldown, so a request may rotate the row. */
const pastCooldown = () => new Date(Date.now() - 2 * DATASET_ROTATION_COOLDOWN_MS);

/** Counts the drizzle `select` and `insert` calls `run` makes on the (mocked-in) test db. Seed data before calling it. */
async function countDbCalls(run: () => Promise<unknown>) {
  const select = vi.spyOn(tdb.db, "select");
  const insert = vi.spyOn(tdb.db, "insert");
  try {
    await run();
    return { select: select.mock.calls.length, insert: insert.mock.calls.length };
  } finally {
    select.mockRestore();
    insert.mockRestore();
  }
}

/** Runs a request that must succeed and returns its verify intent's raw token. */
async function newRequest(email = "reporter@example.com") {
  const result = await requestDatasetAccess(body({ email }), "iphash-seed");
  if (!result.ok || result.mail?.kind !== "dataset_verify") throw new Error("expected a verify intent");
  return result.mail;
}

describe("requestDatasetAccess", () => {
  it("creates one unverified grant and returns a verify intent; the raw token is stored nowhere", async () => {
    const result = await requestDatasetAccess(body(), "iphash-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicResult).toEqual({ ok: true });
    expect(result.mail).toEqual({
      kind: "dataset_verify",
      grantId: expect.any(String),
      email: "reporter@example.com",
      verifyToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      echo: {
        name: "Pat Reporter",
        organization: "The Gazette",
        role: "Data editor",
        category: "journalist",
        intendedUse: "Cross-checking siting announcements for a story.",
        links: ["https://example.com/story"],
      },
    });

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(result.mail?.grantId);
    expect(row.email).toBe("reporter@example.com"); // lowercased + trimmed
    expect(row.status).toBe("unverified");
    expect(row.name).toBe("Pat Reporter");
    expect(row.organization).toBe("The Gazette");
    expect(row.role).toBe("Data editor");
    expect(row.category).toBe("journalist");
    expect(row.links).toEqual(["https://example.com/story"]);
    expect(row.submitterIpHash).toBe("iphash-1");
    expect(row.termsVersion).toBe(DATASET_TERMS_VERSION);
    expect(row.attributionAckAt).toBeInstanceOf(Date);
    expect(row.verifiedAt).toBeNull();
    expect(row.accessTokenHash).toBeNull();

    const raw = result.mail?.kind === "dataset_verify" ? result.mail.verifyToken : "";
    expect(raw).not.toBe("");
    expect(row.verifyTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.verifyTokenHash).toBe(hashToken(raw));
    expect(JSON.stringify(row)).not.toContain(raw);
  });

  it("stores empty optional fields as null", async () => {
    await requestDatasetAccess(body({ organization: "  ", role: undefined, links: undefined }), "iphash-2");
    const [row] = await allRows();
    expect(row.organization).toBeNull();
    expect(row.role).toBeNull();
    expect(row.links).toEqual([]);
  });

  it("rejects an invalid body with a 400 and issues, and inserts nothing", async () => {
    const result = await requestDatasetAccess(body({ attributionAck: false }), "iphash-3");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid request");
      expect(result.issues).toBeDefined();
    }
    expect(await allRows()).toHaveLength(0);
  });

  it("existing pending_review grant: generic success, no mail, no new row, row untouched", async () => {
    const pending = await insertGrant({ status: "pending_review", name: "Original Name" });

    const result = await requestDatasetAccess(body(), "iphash-4");

    expect(result).toStrictEqual({ ok: true, publicResult: { ok: true } });
    expect(await allRows()).toEqual([pending]);
  });

  it("the free renewal levers (extend, renewal link, renewal request) refuse a live COMMERCIAL grant", async () => {
    const renewToken = generateToken();
    const paid = await insertGrant({
      status: "active",
      tier: "commercial",
      category: "commercial",
      accessTokenHash: hashToken("paid-access-2"),
      renewTokenHash: hashToken(renewToken),
      expiresAt: daysFromNow(10),
      paidThrough: daysFromNow(10),
    });

    expect(await extendDatasetGrant(paid.id)).toEqual({ ok: false, reason: "not_eligible" });
    expect(await issueRenewalToken(paid.id)).toEqual({ ok: false, reason: "not_eligible" });
    expect(await requestRenewal(renewToken)).toEqual({ outcome: "invalid" });
    expect(await allRows()).toEqual([paid]);
  });

  it("a live COMMERCIAL grant for the address is not an 'already active' free grant: a free request gets its own verify row", async () => {
    const paid = await insertGrant({
      status: "active",
      tier: "commercial",
      category: "commercial",
      accessTokenHash: hashToken("paid-access"),
      expiresAt: daysFromNow(30),
      paidThrough: daysFromNow(30),
    });

    const result = await requestDatasetAccess(body(), "iphash-paid");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mail?.kind).toBe("dataset_verify");
    const rows = await allRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === paid.id)).toEqual(paid);
    expect(rows.find((r) => r.id !== paid.id)).toMatchObject({ tier: "free", status: "unverified" });
  });

  it("existing active grant: already-active mail, no new row, access token untouched", async () => {
    const active = await insertGrant({
      status: "active",
      accessTokenHash: hashToken("access-1"),
      expiresAt: daysFromNow(30), // live: an expired one is a lapsed grant, not "already active"
    });

    const result = await requestDatasetAccess(body(), "iphash-5");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mail).toEqual({
      kind: "dataset_already_active",
      grantId: active.id,
      email: "reporter@example.com",
    });
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].accessTokenHash).toBe(hashToken("access-1"));
    expect(rows[0].verifyTokenHash).toBe(active.verifyTokenHash);
  });

  it("previously rejected, revoked or expired rows do not block a new request", async () => {
    await insertGrant({ status: "rejected" });
    await insertGrant({ status: "revoked" });
    await insertGrant({ status: "expired" });

    const result = await requestDatasetAccess(body(), "iphash-6");

    expect(result.ok && result.mail?.kind).toBe("dataset_verify");
    const rows = await allRows();
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.status === "unverified")).toHaveLength(1);
  });

  it("over the per-address cap: generic success, no row, no mail", async () => {
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) await insertGrant({ status: "rejected" });

    const result = await requestDatasetAccess(body(), "iphash-7");

    expect(result).toEqual({ ok: true, publicResult: { ok: true } });
    expect(await allRows()).toHaveLength(EMAIL_SEND_CAP_MAX);
  });

  it("globally suppressed address: generic success, no row, no mail", async () => {
    await tdb.db.insert(emailSuppressionsTable).values({ email: "reporter@example.com", source: "admin" });

    const result = await requestDatasetAccess(body(), "iphash-8");

    expect(result).toEqual({ ok: true, publicResult: { ok: true } });
    expect(await allRows()).toHaveLength(0);
  });

  it("globally suppressed address with an active grant: no mail, no new row", async () => {
    await insertGrant({
      status: "active",
      accessTokenHash: hashToken("access-2"),
      expiresAt: daysFromNow(30),
    });
    await tdb.db.insert(emailSuppressionsTable).values({ email: "reporter@example.com", source: "admin" });

    const result = await requestDatasetAccess(body(), "iphash-9");

    expect(result).toEqual({ ok: true, publicResult: { ok: true } });
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  it("suppression lookup 'unknown' (it failed) on a new request: generic success, no row, no mail", async () => {
    const lookup = vi.spyOn(suppressions, "isSuppressed").mockResolvedValue("unknown");
    try {
      const result = await requestDatasetAccess(body(), "iphash-12");

      expect(lookup).toHaveBeenCalledTimes(1);
      expect(result).toStrictEqual({ ok: true, publicResult: { ok: true } });
      expect(await allRows()).toHaveLength(0);
    } finally {
      lookup.mockRestore();
    }

    // Control: the same request with the real lookup IS mailed, so "unknown" is what held it back.
    const control = await requestDatasetAccess(body(), "iphash-12");
    expect(control.ok && control.mail?.kind).toBe("dataset_verify");
    expect(await allRows()).toHaveLength(1);
  });

  it("suppression lookup 'unknown' with an active grant: no mail, no new row, access token untouched", async () => {
    const active = await insertGrant({
      status: "active",
      accessTokenHash: hashToken("access-3"),
      expiresAt: daysFromNow(30),
    });
    const lookup = vi.spyOn(suppressions, "isSuppressed").mockResolvedValue("unknown");
    try {
      const result = await requestDatasetAccess(body(), "iphash-13");

      expect(lookup).toHaveBeenCalledTimes(1);
      expect(result).toStrictEqual({ ok: true, publicResult: { ok: true } });
    } finally {
      lookup.mockRestore();
    }
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].accessTokenHash).toBe(hashToken("access-3"));

    // Control: with the real lookup the same address is told it already has access.
    const control = await requestDatasetAccess(body(), "iphash-13");
    expect(control.ok && control.mail).toEqual({
      kind: "dataset_already_active",
      grantId: active.id,
      email: "reporter@example.com",
    });
  });

  it("query-count symmetry: a brand-new mailable and a brand-new not-mailable request make the same number of select + insert calls", async () => {
    await tdb.db.insert(emailSuppressionsTable).values({ email: "stopped@example.com", source: "admin" });

    const mailable = await countDbCalls(() => requestDatasetAccess(body({ email: "fresh@example.com" }), "iphash-14"));
    const notMailable = await countDbCalls(() => requestDatasetAccess(body({ email: "stopped@example.com" }), "iphash-14"));

    // The two really were different paths: only the mailable one wrote a row...
    expect(mailable.insert).toBe(1);
    expect(notMailable.insert).toBe(0);
    expect(await allRows()).toHaveLength(1);
    // ...yet a caller timing the DB sees the same amount of work.
    expect(mailable.select).toBeGreaterThan(0);
    expect(mailable.select + mailable.insert).toBe(notMailable.select + notMailable.insert);
  });

  it("honeypot: generic success with no row and no mail, for string and non-string values", async () => {
    for (const website of ["http://spam.example", 1, true, { a: 1 }]) {
      const result = await requestDatasetAccess(body({ website }), "iphash-10");
      expect(result).toEqual({ ok: true, publicResult: { ok: true } });
    }
    // Still generic when every other field is garbage: no 400 oracle on the honeypot.
    expect(await requestDatasetAccess({ website: 1, email: "bad" }, "iphash-10")).toEqual({
      ok: true,
      publicResult: { ok: true },
    });
    expect(await allRows()).toHaveLength(0);
  });

  it("honeypot: an un-coercible `website` ({toString:'x'}) answers the same generic success as 'x', never a throw", async () => {
    // `String({toString: "x"})` throws "Cannot convert object to primitive value", and the body is
    // attacker-controlled JSON, so parse it the way the route would.
    const website = JSON.parse('{"toString":"x"}') as unknown;
    expect(() => String(website)).toThrow(TypeError);
    const tripped = await requestDatasetAccess(body({ website: "x" }), "iphash-15");
    expect(tripped).toEqual({ ok: true, publicResult: { ok: true } });
    await expect(requestDatasetAccess(body({ website }), "iphash-15")).resolves.toEqual(tripped);
    // Still generic when every other field is garbage, exactly like a filled string.
    await expect(requestDatasetAccess({ website, email: "bad" }, "iphash-15")).resolves.toEqual(tripped);
    expect(await allRows()).toHaveLength(0);
  });

  it("honeypot: empty and whitespace `website` (even over-long) are 'not filled in', answered exactly like an omitted one", async () => {
    // A filled honeypot is silent; these are values isHoneypotTripped lets through. `website` is deliberately
    // unbounded, so a whitespace-only value over any max cannot skip the honeypot and 400. A valid body is a normal new request...
    const omitted = await requestDatasetAccess(body({ email: "omitted@example.com" }), "iphash-11");
    expect(omitted.ok && omitted.mail?.kind).toBe("dataset_verify");
    let expectedRows = 1;
    for (const [i, website] of ["", "   ", " ".repeat(300)].entries()) {
      const result = await requestDatasetAccess(body({ email: `absent-${i}@example.com`, website }), "iphash-11");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.publicResult).toStrictEqual({ ok: true });
      expect(result.mail?.kind).toBe("dataset_verify");
      expect(await allRows()).toHaveLength(++expectedRows);
    }

    // ...and an invalid body answers the SAME 400 as it does with `website` omitted, none of it about `website`.
    const rowsBefore = (await allRows()).length;
    const invalidOmitted = await requestDatasetAccess({ email: "bad" }, "iphash-11");
    expect(invalidOmitted.ok).toBe(false);
    for (const website of ["", "   ", " ".repeat(300)]) {
      const invalid = await requestDatasetAccess({ email: "bad", website }, "iphash-11");
      expect(invalid).toStrictEqual(invalidOmitted);
      expect(JSON.stringify(invalid)).not.toContain("website");
    }
    expect(await allRows()).toHaveLength(rowsBefore);
  });

  it("honeypot: null and false `website` are 'present but not filled in', so they get the same 400 as a non-string value in any other optional string field", async () => {
    // isHoneypotTripped lets null and false through, so they are validated normally. `website` is a plain
    // optional string, so they are rejected exactly as `organization: null` / `organization: false` are.
    // That 400 is not an oracle: every optional string field answers the same way.
    for (const value of [null, false]) {
      const control = await requestDatasetAccess(body({ organization: value }), "iphash-11");
      expect(control).toMatchObject({ ok: false, status: 400, error: "Invalid request" });
      const result = await requestDatasetAccess(body({ website: value }), "iphash-11");
      expect(result).toMatchObject({ ok: false, status: 400, error: "Invalid request" });
      if (result.ok || control.ok) throw new Error("expected a 400");
      // Same shape: one issue with the same Zod code and message; only the field path differs.
      const strip = (issues: unknown) =>
        (issues as Array<{ path: unknown[] }>).map(({ path, ...rest }) => ({ path: path.length, ...rest }));
      expect(strip(result.issues)).toEqual(strip(control.issues));
      expect(result.issues as Array<{ path: unknown[] }>).toHaveLength(1);
      expect((result.issues as Array<{ path: unknown[] }>)[0].path).toEqual(["website"]);
      expect((control.issues as Array<{ path: unknown[] }>)[0].path).toEqual(["organization"]);
    }
    expect(await allRows()).toHaveLength(0);
  });

  it("enumeration safety: publicResult is the same object shape on every success path", async () => {
    const results: Array<Awaited<ReturnType<typeof requestDatasetAccess>>> = [];

    // new
    results.push(await requestDatasetAccess(body({ email: "new@example.com" }), "ip"));
    // honeypot: string and non-string
    results.push(await requestDatasetAccess(body({ website: "x" }), "ip"));
    results.push(await requestDatasetAccess(body({ website: 1 }), "ip"));
    // over the cap
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) await insertGrant({ email: "capped@example.com", status: "rejected" });
    results.push(await requestDatasetAccess(body({ email: "capped@example.com" }), "ip"));
    // globally suppressed
    await tdb.db.insert(emailSuppressionsTable).values({ email: "stopped@example.com", source: "admin" });
    results.push(await requestDatasetAccess(body({ email: "stopped@example.com" }), "ip"));
    // existing unverified: rotated (past the cooldown) and inside the cooldown (nothing sent)
    await insertGrant({ email: "unv@example.com", status: "unverified", createdAt: pastCooldown() });
    results.push(await requestDatasetAccess(body({ email: "unv@example.com" }), "ip"));
    await insertGrant({ email: "young@example.com", status: "unverified" });
    results.push(await requestDatasetAccess(body({ email: "young@example.com" }), "ip"));
    // existing pending_review / active: live, renewal-pending and lapsed
    await insertGrant({ email: "pend@example.com", status: "pending_review" });
    results.push(await requestDatasetAccess(body({ email: "pend@example.com" }), "ip"));
    await insertGrant({ email: "act@example.com", status: "active", expiresAt: daysFromNow(30) });
    results.push(await requestDatasetAccess(body({ email: "act@example.com" }), "ip"));
    await insertGrant({
      email: "renew@example.com",
      status: "active",
      expiresAt: daysFromNow(-1),
      renewalRequestedAt: daysFromNow(-2),
    });
    results.push(await requestDatasetAccess(body({ email: "renew@example.com" }), "ip"));
    await insertGrant({ email: "lapsed@example.com", status: "active", expiresAt: daysFromNow(-1) });
    results.push(await requestDatasetAccess(body({ email: "lapsed@example.com" }), "ip"));
    // previously rejected: re-request creates a new row
    const rejected = await insertGrant({ email: "rej@example.com", status: "rejected" });
    results.push(await requestDatasetAccess(body({ email: "rej@example.com" }), "ip"));
    const rejRows = await tdb.db
      .select()
      .from(datasetAccessGrantsTable)
      .where(eq(datasetAccessGrantsTable.email, "rej@example.com"));
    expect(rejRows).toHaveLength(2);
    expect(rejRows.some((r) => r.id === rejected.id)).toBe(true);

    expect(results).toHaveLength(12);
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.publicResult).toStrictEqual({ ok: true });
    }
    // The paths really differed (the mail intent travels beside publicResult, never in it).
    expect(new Set(results.map((r) => (r.ok ? r.mail?.kind : "error")))).toEqual(
      new Set(["dataset_verify", "dataset_already_active", undefined])
    );
  });
});

describe("requestDatasetAccess: unstorable free text", () => {
  const getDb = () => vi.mocked(dbClient.getDb);
  const BAD = ["a\u0000b", "\ud800", "x\udc00y"] as const; // NUL, lone high surrogate, lone low surrogate
  const FIELDS = ["name", "organization", "role", "intendedUse"] as const;

  it.each(FIELDS.flatMap((field) => BAD.map((bad) => [field, bad] as const)))(
    "%s containing %j: the same 400 on a fresh, an open-row and a suppressed address, with zero getDb calls",
    async (field, bad) => {
      await insertGrant({ email: "open-row@example.com", status: "pending_review" });
      await tdb.db.insert(emailSuppressionsTable).values({ email: "stopped@example.com", source: "admin" });
      const rowsBefore = await allRows();

      const results = [];
      for (const email of ["fresh@example.com", "open-row@example.com", "stopped@example.com"]) {
        getDb().mockClear();
        results.push(await requestDatasetAccess(body({ email, [field]: bad }), "iphash-bad"));
        expect(getDb()).not.toHaveBeenCalled(); // parsing precedes any DB access
      }

      expect(results[0]).toStrictEqual({
        ok: false,
        status: 400,
        error: "Invalid request",
        issues: [expect.objectContaining({ path: [field], message: "Remove unsupported characters." })],
      });
      expect(results[1]).toStrictEqual(results[0]);
      expect(results[2]).toStrictEqual(results[0]);
      expect(await allRows()).toEqual(rowsBefore); // nothing inserted or changed
    }
  );

  it.each(["rep\u0000orter@example.com", "reporter\ud800@example.com"])(
    "email %j: the same 400 with zero getDb calls",
    async (email) => {
      getDb().mockClear();

      const result = await requestDatasetAccess(body({ email }), "iphash-bad");

      expect(getDb()).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        status: 400,
        error: "Invalid request",
        issues: [expect.objectContaining({ path: ["email"] })],
      });
    }
  );

  it("still stores ordinary non-ASCII text and a valid surrogate pair", async () => {
    const result = await requestDatasetAccess(
      body({ name: "Zoë Müller 😀", intendedUse: "Reporting on 数据中心 siting 📊" }),
      "iphash-ok"
    );

    expect(result.ok && result.mail?.kind).toBe("dataset_verify");
    const [row] = await allRows();
    expect(row.name).toBe("Zoë Müller 😀");
    expect(row.intendedUse).toBe("Reporting on 数据中心 siting 📊");
  });
});

/**
 * Simulates a concurrent writer landing between `requestDatasetAccess`'s open-row lookup (the only
 * select that projects `lapsed`) and the write that follows it: runs `hook` after that
 * lookup has read its row and before the function sees it. PGlite serialises queries, so this is how
 * the race window is reproduced deterministically. Restore the returned spy in a `finally`.
 */
type LookupChain = {
  from: (table: unknown) => LookupChain;
  where: (condition: unknown) => LookupChain;
  limit: (n: number) => Promise<unknown[]>;
};
function afterOpenRowLookup(hook: () => Promise<unknown>) {
  const realSelect = tdb.db.select.bind(tdb.db) as unknown as (fields?: unknown) => LookupChain;
  return vi.spyOn(tdb.db, "select").mockImplementation(((fields?: unknown) => {
    const chain = realSelect(fields);
    if (!fields || typeof fields !== "object" || !("lapsed" in fields)) return chain;
    return {
      from: (table: unknown) => ({
        where: (condition: unknown) => ({
          limit: async (n: number) => {
            const rows = await chain.from(table).where(condition).limit(n);
            await hook();
            return rows;
          },
        }),
      }),
    };
  }) as never);
}

/**
 * Spies on `select` so the computed `sql<boolean>` projection `key` ("live" or "lapsed") comes back as
 * `value`, which is what a driver that does not map booleans may hand over ("f", null, ...). Drizzle does not
 * map those fields, so nothing else stands between the raw driver value and the code. Every other column is
 * the real one. `rewrites()` counts the lookups that were rewritten, so a test can prove the spy took effect.
 * Restore the returned spy in a `finally`.
 */
function misparsedProjection(key: "live" | "lapsed", value: unknown) {
  const realSelect = tdb.db.select.bind(tdb.db) as unknown as (fields?: unknown) => LookupChain;
  let rewrites = 0;
  const spy = vi.spyOn(tdb.db, "select").mockImplementation(((fields?: unknown) => {
    const chain = realSelect(fields);
    if (!fields || typeof fields !== "object" || !(key in fields)) return chain;
    return {
      from: (table: unknown) => ({
        where: (condition: unknown) => ({
          limit: async (n: number) => {
            const rows = await chain.from(table).where(condition).limit(n);
            rewrites += rows.length;
            return rows.map((row) => ({ ...(row as object), [key]: value }));
          },
        }),
      }),
    };
  }) as never);
  return { spy, rewrites: () => rewrites };
}

describe("requestDatasetAccess: one open request per email", () => {
  it("10 parallel requests for one fresh address leave exactly one open row and send exactly one verify mail; its token verifies", async () => {
    // PGlite serialises queries, so this proves the partial unique index and the branch logic, not
    // real interleaving; the race window itself is reproduced by the afterOpenRowLookup tests below.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => requestDatasetAccess(body(), `iphash-burst-${i}`))
    );

    for (const r of results) expect(r.ok && r.publicResult).toStrictEqual({ ok: true });
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unverified");

    // The rotation cooldown: only the request that created the row mails. Every other one finds that
    // young unverified row (or loses the index), sends nothing, and so never kills the first link.
    const issued = results.flatMap((r) => (r.ok && r.mail?.kind === "dataset_verify" ? [r.mail.verifyToken] : []));
    expect(issued).toHaveLength(1);
    expect(hashToken(issued[0])).toBe(rows[0].verifyTokenHash);
    expect(await verifyDatasetRequest(issued[0])).toMatchObject({ outcome: "verified" });
    expect((await allRows())[0].status).toBe("pending_review");
  });

  it("squatting: a stranger's unverified request is taken over by the real owner; the old link dies", async () => {
    const attackerToken = generateToken();
    const squat = await insertGrant({
      status: "unverified",
      name: "Attacker",
      organization: "Evil Corp",
      role: "CEO",
      category: "commercial",
      intendedUse: "attacker's use",
      links: ["https://evil.example/"],
      attributionAckAt: daysFromNow(-1),
      termsVersion: "attacker-terms",
      submitterIpHash: "attacker-ip",
      verifyTokenHash: hashToken(attackerToken),
      createdAt: daysFromNow(-1),
    });

    // The owner leaves organization and role out.
    const result = await requestDatasetAccess(body({ organization: undefined, role: undefined }), "owner-ip");

    expect(result.ok).toBe(true);
    if (!result.ok || result.mail?.kind !== "dataset_verify") throw new Error("expected a verify intent");
    expect(result.publicResult).toStrictEqual({ ok: true });
    expect(result.mail).toEqual({
      kind: "dataset_verify",
      grantId: squat.id,
      email: "reporter@example.com",
      verifyToken: expect.stringMatching(DATASET_TOKEN_RE),
      echo: { name: "Pat Reporter", organization: null, role: null, category: "journalist", intendedUse: "Cross-checking siting announcements for a story.", links: ["https://example.com/story"] },
    });
    expect(JSON.stringify(result.mail.echo)).not.toMatch(/Attacker|Evil Corp|evil\.example/);
    const newToken = result.mail.verifyToken;
    expect(newToken).not.toBe(attackerToken);

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(squat.id);
    expect(row.status).toBe("unverified");
    // Every request field now comes from the owner's submission.
    expect(row.name).toBe("Pat Reporter");
    expect(row.organization).toBeNull();
    expect(row.role).toBeNull();
    expect(row.category).toBe("journalist");
    expect(row.intendedUse).toBe("Cross-checking siting announcements for a story.");
    expect(row.links).toEqual(["https://example.com/story"]);
    expect(row.termsVersion).toBe(DATASET_TERMS_VERSION);
    expect(row.submitterIpHash).toBe("owner-ip");
    expect(row.attributionAckAt.getTime()).toBeGreaterThan(squat.attributionAckAt.getTime());
    expect(row.createdAt.getTime()).toBeGreaterThan(squat.createdAt.getTime());
    expect(row.verifyTokenHash).toBe(hashToken(newToken));
    expect(JSON.stringify(row)).not.toContain(newToken);

    // The squatter's link is dead; the owner's works.
    expect(await verifyDatasetRequest(attackerToken)).toStrictEqual({ outcome: "invalid" });
    expect((await allRows())[0].status).toBe("unverified");
    expect(await verifyDatasetRequest(newToken)).toMatchObject({
      outcome: "verified",
      mail: { kind: "dataset_admin_new_request", grantId: squat.id, name: "Pat Reporter", organization: null },
    });
    expect((await allRows())[0].status).toBe("pending_review");
  });

  it("rotating an unverified row older than the verify TTL gives the new link a full term", async () => {
    const stale = await insertGrant({ status: "unverified", createdAt: daysFromNow(-8) });

    const result = await requestDatasetAccess(body(), "iphash-rot");

    if (!result.ok || result.mail?.kind !== "dataset_verify") throw new Error("expected a verify intent");
    expect(result.mail.grantId).toBe(stale.id);
    expect(await verifyDatasetRequest(result.mail.verifyToken)).toMatchObject({ outcome: "verified" });
  });

  describe("rotation cooldown", () => {
    // Only `Date` is faked: PGlite and the rest of the event loop keep real timers.
    afterEach(() => {
      vi.useRealTimers();
    });
    const MINUTE_MS = 60_000;

    it("is twenty minutes", () => {
      expect(DATASET_ROTATION_COOLDOWN_MS).toBe(20 * MINUTE_MS);
    });

    it("a fresh insert sends createdAt from the app clock `now`, not the database default", async () => {
      // PGlite's own `now()` follows the faked `Date`, so the stored row cannot tell the two clocks apart:
      // the proof is in the INSERT the function sends, where `created_at` must be a bound value, not `default`.
      const instant = new Date("2031-03-04T05:06:07.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(instant);
      const query = vi.spyOn(tdb.client, "query");
      try {
        const result = await requestDatasetAccess(body(), "iphash-clock");

        expect(result.ok && result.mail?.kind).toBe("dataset_verify");
        const inserts = query.mock.calls.filter(([text]) => String(text).startsWith('insert into "dataset_access_grants"'));
        expect(inserts).toHaveLength(1);
        const [text, params] = inserts[0] as unknown as [string, unknown[]];
        const parts = /^insert into "dataset_access_grants" \((.*?)\) values \((.*?)\)(?: on conflict|$)/.exec(text);
        if (!parts) throw new Error(`unexpected INSERT shape: ${text}`);
        const columns = parts[1].split(", ");
        const values = parts[2].split(", ");
        expect(columns).toContain('"created_at"');
        const placeholder = values[columns.indexOf('"created_at"')]; // `default` would mean the database clock
        expect(placeholder).toMatch(/^\$\d+$/);
        expect(params[Number(placeholder.slice(1)) - 1]).toBe(instant.toISOString());
      } finally {
        query.mockRestore();
      }
      const [row] = await allRows();
      expect(row.createdAt.getTime()).toBe(instant.getTime());
    });

    it("a second request 5 minutes after the first sends nothing: the row is untouched and the first token still verifies", async () => {
      const first = await newRequest();
      const [before] = await allRows();

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 5 * MINUTE_MS);
      // A different name and use, as a stranger would send: none of it may land on the row.
      const second = await requestDatasetAccess(body({ name: "A Stranger", intendedUse: "Some other use." }), "stranger-ip");

      expect(second).toStrictEqual({ ok: true, publicResult: { ok: true } }); // no mail
      const rows = await allRows();
      expect(rows).toEqual([before]); // every field, createdAt included, exactly as first stored
      expect(rows[0].verifyTokenHash).toBe(hashToken(first.verifyToken));
      expect(await verifyDatasetRequest(first.verifyToken)).toMatchObject({ outcome: "verified" });
    });

    it("21 minutes after the first request the next one rotates: the old token is dead and the new one verifies", async () => {
      const first = await newRequest();

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 21 * MINUTE_MS);
      const second = await requestDatasetAccess(body(), "owner-ip-2");

      if (!second.ok || second.mail?.kind !== "dataset_verify") throw new Error("expected a verify intent");
      expect(second.mail.grantId).toBe(first.grantId);
      expect(second.mail.verifyToken).not.toBe(first.verifyToken);
      expect(await allRows()).toHaveLength(1);
      expect(await verifyDatasetRequest(first.verifyToken)).toStrictEqual({ outcome: "invalid" });
      expect(await verifyDatasetRequest(second.mail.verifyToken)).toMatchObject({ outcome: "verified" });
    });

    it("a rotation with different content echoes the NEW content, the same that was stored with the new token", async () => {
      await newRequest();

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 21 * MINUTE_MS);
      const second = await requestDatasetAccess(
        body({
          name: "A Stranger",
          organization: "",
          role: "Analyst",
          category: "commercial",
          intendedUse: "Some other use.",
          links: ["https://example.org/other"],
        }),
        "stranger-ip"
      );

      if (!second.ok || second.mail?.kind !== "dataset_verify") throw new Error("expected a verify intent");
      expect(second.mail.echo).toEqual({
        name: "A Stranger",
        organization: null,
        role: "Analyst",
        category: "commercial",
        intendedUse: "Some other use.",
        links: ["https://example.org/other"],
      });
      const [row] = await allRows();
      expect(row.name).toBe("A Stranger");
      expect(row.intendedUse).toBe("Some other use.");
    });

    it("the boundary is inclusive: a row exactly 20 minutes old rotates, one a millisecond younger does not", async () => {
      vi.useFakeTimers({ toFake: ["Date"] }); // frozen at "now", so the cutoff is exact
      const now = Date.now();
      await insertGrant({
        email: "exact@example.com",
        status: "unverified",
        createdAt: new Date(now - DATASET_ROTATION_COOLDOWN_MS),
      });
      const young = await insertGrant({
        email: "young@example.com",
        status: "unverified",
        createdAt: new Date(now - DATASET_ROTATION_COOLDOWN_MS + 1),
      });

      const rotated = await requestDatasetAccess(body({ email: "exact@example.com" }), "ip-exact");
      const held = await requestDatasetAccess(body({ email: "young@example.com" }), "ip-young");

      expect(rotated.ok && rotated.mail?.kind).toBe("dataset_verify");
      expect(held).toStrictEqual({ ok: true, publicResult: { ok: true } });
      expect(await rowById(young.id)).toEqual(young);
    });
  });

  describe("the INSERT's conflict target", () => {
    it("is the partial unique index: the emitted SQL names the email and tier columns and the open-status predicate", async () => {
      const query = vi.spyOn(tdb.client, "query");
      try {
        const result = await requestDatasetAccess(body(), "iphash-sql");

        expect(result.ok && result.mail?.kind).toBe("dataset_verify");
        const inserts = query.mock.calls
          .map(([text]) => String(text))
          .filter((text) => text.startsWith('insert into "dataset_access_grants"'));
        expect(inserts).toHaveLength(1);
        expect(inserts[0]).toContain(
          `on conflict ("email","tier") where "dataset_access_grants"."status" in ('unverified', 'pending_review', 'active') do nothing`
        );
      } finally {
        query.mockRestore();
      }
    });

    it("a unique violation on any OTHER index is a real error, not swallowed as 'someone else took the slot'", async () => {
      const colliding = generateToken();
      await insertGrant({ email: "other@example.com", status: "unverified", verifyTokenHash: hashToken(colliding) });
      const mint = vi.spyOn(emailModule, "generateToken").mockReturnValue(colliding);
      try {
        await expect(requestDatasetAccess(body({ email: "fresh@example.com" }), "iphash-collide")).rejects.toMatchObject({
          cause: expect.objectContaining({ code: "23505" }),
        });
      } finally {
        mint.mockRestore();
      }
      expect(await allRows()).toHaveLength(1); // only the seeded row: nothing was inserted
    });
  });

  it("an unverified row on a suppressed address: generic, no mail, row untouched", async () => {
    const original = await insertGrant({ status: "unverified" });
    await tdb.db.insert(emailSuppressionsTable).values({ email: "reporter@example.com", source: "admin" });

    const result = await requestDatasetAccess(body({ name: "Someone Else" }), "iphash-sup");

    expect(result).toStrictEqual({ ok: true, publicResult: { ok: true } });
    expect(await allRows()).toEqual([original]);
  });

  it("the unverified row is verified between the lookup and the rotation: generic, no mail, row not rotated", async () => {
    // Older than the cooldown, so the rotation IS attempted and it is the status guard that stops it.
    const original = await insertGrant({ status: "unverified", name: "Original", createdAt: pastCooldown() });
    const spy = afterOpenRowLookup(() =>
      tdb.client.query(
        `UPDATE dataset_access_grants SET status = 'pending_review', verified_at = now() WHERE id = $1`,
        [original.id]
      )
    );
    try {
      const result = await requestDatasetAccess(body(), "iphash-race");

      expect(result).toStrictEqual({ ok: true, publicResult: { ok: true } });
    } finally {
      spy.mockRestore();
    }
    const [row] = await allRows();
    expect(row.status).toBe("pending_review");
    expect(row.name).toBe("Original");
    expect(row.verifyTokenHash).toBe(original.verifyTokenHash);
  });

  it("a concurrent request wins the open slot between the lookup and the INSERT: generic, no mail, one row", async () => {
    // Pre-inserting the open row inside the lookup/INSERT window is the same event the partial unique
    // index arbitrates between two live requests.
    const spy = afterOpenRowLookup(() => insertGrant({ status: "unverified", name: "Winner" }));
    try {
      const result = await requestDatasetAccess(body(), "iphash-loser");

      expect(result).toStrictEqual({ ok: true, publicResult: { ok: true } });
    } finally {
      spy.mockRestore();
    }
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Winner");
  });

  describe("an active grant", () => {
    it("lapsed with no renewal requested: expired, and a NEW unverified row is inserted with a verify intent", async () => {
      for (const [email, expiresAt] of [
        ["past@example.com", daysFromNow(-1)],
        ["null@example.com", null],
      ] as const) {
        const old = await insertGrant({
          email,
          status: "active",
          accessTokenHash: hashToken(`access-${email}`),
          expiresAt,
        });

        const result = await requestDatasetAccess(body({ email }), "iphash-lapsed");

        expect(result.ok && result.mail?.kind).toBe("dataset_verify");
        if (!result.ok || result.mail?.kind !== "dataset_verify") return;
        const rows = (await allRows()).filter((r) => r.email === email);
        expect(rows).toHaveLength(2);
        expect((await rowById(old.id)).status).toBe("expired");
        const fresh = rows.find((r) => r.id !== old.id);
        expect(fresh?.status).toBe("unverified");
        expect(fresh?.id).toBe(result.mail.grantId);
        expect(fresh?.verifyTokenHash).toBe(hashToken(result.mail.verifyToken));
      }
    });

    it("lapsed but with a renewal requested: already-active intent, no new row, the old row stays active", async () => {
      const old = await insertGrant({
        status: "active",
        accessTokenHash: hashToken("access-renewal"),
        expiresAt: daysFromNow(-3),
        renewalRequestedAt: daysFromNow(-10),
      });

      const result = await requestDatasetAccess(body(), "iphash-renewal");

      expect(result).toStrictEqual({
        ok: true,
        publicResult: { ok: true },
        mail: { kind: "dataset_already_active", grantId: old.id, email: "reporter@example.com" },
      });
      expect(await allRows()).toEqual([old]);
    });

    it("lapsed on a suppressed address: marked expired, but no new row and no mail", async () => {
      const old = await insertGrant({ status: "active", expiresAt: daysFromNow(-1) });
      await tdb.db.insert(emailSuppressionsTable).values({ email: "reporter@example.com", source: "admin" });

      const result = await requestDatasetAccess(body(), "iphash-lapsed-sup");

      expect(result).toStrictEqual({ ok: true, publicResult: { ok: true } });
      const rows = await allRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(old.id);
      expect(rows[0].status).toBe("expired");
    });

    // `lapsed` is a computed sql<boolean>, so the driver's raw value reaches the code unmapped. Only a real
    // `false` may take the branch that mails; any other value takes the SQL-guarded lapsed branch, which for a
    // LIVE or RENEWAL_PENDING row matches nothing and leaves the INSERT to meet the partial unique index.
    const MISPARSED = ["f", "false", "", 0, null, undefined] as const;
    const NOT_LAPSED = {
      live: () => ({ expiresAt: daysFromNow(30) }),
      "renewal-pending": () => ({ expiresAt: daysFromNow(-3), renewalRequestedAt: daysFromNow(-10) }),
    } as const;
    it.each(
      (Object.keys(NOT_LAPSED) as Array<keyof typeof NOT_LAPSED>).flatMap((scenario) =>
        MISPARSED.map((bad) => [scenario, bad] as const)
      )
    )(
      "a %s grant whose `lapsed` projection is mis-parsed as %j: generic, no mail, the row is intact",
      async (scenario, bad) => {
        const old = await insertGrant({
          status: "active",
          accessTokenHash: hashToken("access-misparse"),
          ...NOT_LAPSED[scenario](),
        });
        const mis = misparsedProjection("lapsed", bad);
        try {
          const result = await requestDatasetAccess(body(), "iphash-misparse");

          expect(result).toStrictEqual({ ok: true, publicResult: { ok: true } }); // not already_active, not verify
        } finally {
          mis.spy.mockRestore();
        }
        expect(mis.rewrites()).toBe(1); // the spy really did replace the projection
        expect(await allRows()).toEqual([old]);
      }
    );

    it("a failed lazy expiry is best effort: generic, no mail, the row stays active, logged by SQLSTATE only", async () => {
      const old = await insertGrant({
        status: "active",
        accessTokenHash: hashToken("access-lazy-fail"),
        expiresAt: daysFromNow(-1),
      });
      const update = vi.spyOn(tdb.db, "update").mockImplementation((() => {
        // The shape of a drizzle wrapper: the message embeds the bound params, the driver code sits on `cause`.
        throw new Error(`Failed query: update "dataset_access_grants" params: ${old.email},${old.id}`, {
          cause: Object.assign(new Error("connection terminated"), { code: "08006" }),
        });
      }) as never);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await requestDatasetAccess(body(), "iphash-lazy-fail");

        // The INSERT then meets the partial unique index (the row is still open): a conflict, so generic.
        expect(result).toStrictEqual({ ok: true, publicResult: { ok: true } });
        expect(log).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(log.mock.calls);
        expect(logged).toContain("dataset lazy expiry failed");
        expect(logged).toContain("08006");
        for (const secret of [old.email, old.id, old.accessTokenHash, old.verifyTokenHash, "iphash-lazy-fail", "Failed query"]) {
          expect(logged).not.toContain(secret as string);
        }
      } finally {
        update.mockRestore();
        log.mockRestore();
      }
      expect(await allRows()).toEqual([old]);
    });

    it("renewed between the lookup and the lazy expiry: the guard leaves it active, no new row, no mail", async () => {
      const old = await insertGrant({ status: "active", expiresAt: daysFromNow(-1) });
      const spy = afterOpenRowLookup(() =>
        tdb.client.query(`UPDATE dataset_access_grants SET renewal_requested_at = now() WHERE id = $1`, [old.id])
      );
      try {
        const result = await requestDatasetAccess(body(), "iphash-renew-race");

        expect(result).toStrictEqual({ ok: true, publicResult: { ok: true } });
      } finally {
        spy.mockRestore();
      }
      const rows = await allRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("active");
    });
  });
});

describe("verifyDatasetRequest", () => {
  it("moves unverified to pending_review, stamps verifiedAt and returns the admin intent", async () => {
    const { verifyToken, grantId } = await newRequest();

    const result = await verifyDatasetRequest(verifyToken);

    expect(result).toStrictEqual({
      outcome: "verified",
      mail: { kind: "dataset_admin_new_request", grantId, name: "Pat Reporter", organization: "The Gazette" },
    });
    const [row] = await allRows();
    expect(row.status).toBe("pending_review");
    expect(row.verifiedAt).toBeInstanceOf(Date);
  });

  it("a repeat of the same token is verified with NO admin intent", async () => {
    const { verifyToken } = await newRequest();
    await verifyDatasetRequest(verifyToken);

    const second = await verifyDatasetRequest(verifyToken);

    expect(second).toStrictEqual({ outcome: "verified" });
    const [row] = await allRows();
    expect(row.status).toBe("pending_review");
  });

  it("two concurrent verifies yield exactly one admin intent", async () => {
    const { verifyToken } = await newRequest();

    // PGlite serialises queries: this proves the WHERE guard, not real interleaving.
    const results = await Promise.all([verifyDatasetRequest(verifyToken), verifyDatasetRequest(verifyToken)]);

    expect(results.every((r) => r.outcome === "verified")).toBe(true);
    expect(results.filter((r) => "mail" in r && r.mail)).toHaveLength(1);
  });

  it("a malformed token is invalid and never touches the database", async () => {
    const getDb = vi.mocked(dbClient.getDb);
    getDb.mockClear();

    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`, `${"a".repeat(42)} `]) {
      expect(await verifyDatasetRequest(bad)).toStrictEqual({ outcome: "invalid" });
    }
    expect(getDb).not.toHaveBeenCalled();
  });

  it("an unknown well-formed token is invalid", async () => {
    await newRequest();
    expect(await verifyDatasetRequest("A".repeat(43))).toStrictEqual({ outcome: "invalid" });
  });

  it("a token whose row never verified and is no longer unverified (e.g. rejected) is invalid and the row is untouched", async () => {
    const token = generateToken();
    await insertGrant({ status: "rejected", verifyTokenHash: hashToken(token), verifiedAt: null });

    expect(await verifyDatasetRequest(token)).toStrictEqual({ outcome: "invalid" });

    const [row] = await allRows();
    expect(row.status).toBe("rejected");
    expect(row.verifiedAt).toBeNull();
  });

  it("the stored hash is not itself a usable token", async () => {
    await newRequest();
    const [row] = await allRows();
    expect(await verifyDatasetRequest(row.verifyTokenHash)).toStrictEqual({ outcome: "invalid" });
    expect((await allRows())[0].status).toBe("unverified");
  });

  describe("verify TTL", () => {
    it("is seven days", () => {
      expect(DATASET_VERIFY_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("an unverified row older than the TTL is invalid and the row is unchanged", async () => {
      const token = generateToken();
      const stale = await insertGrant({
        status: "unverified",
        verifyTokenHash: hashToken(token),
        createdAt: daysFromNow(-8),
      });

      expect(await verifyDatasetRequest(token)).toStrictEqual({ outcome: "invalid" });

      expect(await allRows()).toEqual([stale]);
    });

    it("an unverified row inside the TTL verifies", async () => {
      const token = generateToken();
      await insertGrant({ status: "unverified", verifyTokenHash: hashToken(token), createdAt: daysFromNow(-6) });

      expect(await verifyDatasetRequest(token)).toMatchObject({ outcome: "verified" });

      expect((await allRows())[0].status).toBe("pending_review");
    });

    it("the already-verified fallback is not subject to the TTL", async () => {
      const token = generateToken();
      await insertGrant({
        status: "pending_review",
        verifyTokenHash: hashToken(token),
        verifiedAt: daysFromNow(-29),
        createdAt: daysFromNow(-30),
      });

      expect(await verifyDatasetRequest(token)).toStrictEqual({ outcome: "verified" }); // no admin intent
    });
  });
});

describe("checkDatasetRequestEmailCap", () => {
  it("is ok below the cap and not ok at EMAIL_SEND_CAP_MAX rows in the window", async () => {
    // Closed rows: the cap counts rows of any status, and the open-email index forbids N open rows per address.
    for (let i = 0; i < EMAIL_SEND_CAP_MAX - 1; i++) await insertGrant({ status: "rejected" });
    expect((await checkDatasetRequestEmailCap("reporter@example.com")).ok).toBe(true);

    await insertGrant({ status: "rejected" });
    expect((await checkDatasetRequestEmailCap("reporter@example.com")).ok).toBe(false);
  });

  it("does not count commercial rows (a purchase under an address cannot use up its free-request cap)", async () => {
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) {
      await insertGrant({ status: "revoked", tier: "commercial", category: "commercial" });
    }
    expect((await checkDatasetRequestEmailCap("reporter@example.com")).ok).toBe(true);
  });

  it("counts only this address", async () => {
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) await insertGrant({ email: "other@example.com", status: "rejected" });
    expect((await checkDatasetRequestEmailCap("reporter@example.com")).ok).toBe(true);
  });

  it("ignores rows older than the window", async () => {
    const old = new Date(Date.now() - RATE_LIMIT_WINDOW_MS - 60_000);
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) await insertGrant({ createdAt: old, status: "rejected" });
    expect((await checkDatasetRequestEmailCap("reporter@example.com")).ok).toBe(true);
  });
});

// ---- Grant lifecycle after verification ----

const DAY_MS = 24 * 60 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;
const NOT_ELIGIBLE = { ok: false, reason: "not_eligible" } as const;
const getDbMock = () => vi.mocked(dbClient.getDb);

type GrantInsert = Partial<typeof datasetAccessGrantsTable.$inferInsert>;

const rowById = async (id: string) => {
  const row = (await allRows()).find((r) => r.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
};

/** A grant as `verifyDatasetRequest` leaves it. */
const pendingGrant = (over: GrantInsert = {}) =>
  insertGrant({ status: "pending_review", verifiedAt: new Date(), ...over });

/** An active grant with a known raw access token. */
async function activeGrant(over: GrantInsert = {}) {
  const accessToken = generateToken();
  const row = await insertGrant({
    status: "active",
    accessTokenHash: hashToken(accessToken),
    approvedAt: new Date(),
    expiresAt: new Date(Date.now() + DATASET_GRANT_TERM_MS),
    ...over,
  });
  return { row, accessToken };
}

/** Approves a pending grant that must be approvable and returns its mail intent. */
async function approve(id: string, opts: { reviewNote?: string } = {}) {
  const result = await approveDatasetGrant(id, opts);
  if (!result.ok || result.kind !== "approved") throw new Error("expected an approval");
  return result.mail;
}

const expectNearTerm = (expiresAt: Date | null, from = Date.now()) => {
  expect(expiresAt).toBeInstanceOf(Date);
  expect(Math.abs((expiresAt as Date).getTime() - (from + DATASET_GRANT_TERM_MS))).toBeLessThan(5_000);
};

describe("every mutator: an id that is not a UUID", () => {
  it("is not_eligible and never reaches the database", async () => {
    const calls = [
      (id: string) => approveDatasetGrant(id),
      (id: string) => rejectDatasetGrant(id),
      (id: string) => revokeDatasetGrant(id),
      (id: string) => reissueDatasetLink(id),
      (id: string) => extendDatasetGrant(id),
      (id: string) => issueRenewalToken(id),
    ];
    getDbMock().mockClear();
    for (const call of calls) {
      for (const bad of ["", "not-a-uuid", "1", "' OR 1=1 --", `${crypto.randomUUID()}0`]) {
        expect(await call(bad)).toStrictEqual(NOT_ELIGIBLE);
      }
    }
    expect(getDbMock()).not.toHaveBeenCalled();
  });

  it("a well-formed id with no row is not_eligible", async () => {
    expect(await approveDatasetGrant(crypto.randomUUID())).toStrictEqual(NOT_ELIGIBLE);
    expect(await extendDatasetGrant(crypto.randomUUID())).toStrictEqual(NOT_ELIGIBLE);
  });

  it("every failure is the same frozen object, so a caller cannot poison the next result", async () => {
    const failures = [await approveDatasetGrant(crypto.randomUUID()), await extendDatasetGrant("not-a-uuid")];
    expect(failures[0]).toBe(failures[1]);
    expect(Object.isFrozen(failures[0])).toBe(true);
  });
});

describe("approveDatasetGrant", () => {
  it("moves pending_review to active: stores only the hash, sets the unsubscribe token, review fields and expiry", async () => {
    const g = await pendingGrant();
    const before = Date.now();

    const result = await approveDatasetGrant(g.id, { reviewNote: "  looks legitimate  " });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "approved") throw new Error("expected an approval");
    expect(result.mail).toEqual({
      kind: "dataset_approved",
      grantId: g.id,
      email: "reporter@example.com",
      accessToken: expect.stringMatching(DATASET_TOKEN_RE),
    });
    const raw = result.mail.accessToken;
    const row = await rowById(g.id);
    expect(row.status).toBe("active");
    expect(row.accessTokenHash).toMatch(HEX64);
    expect(row.accessTokenHash).toBe(hashToken(raw));
    expect(JSON.stringify(row)).not.toContain(raw);
    expect(row.unsubscribeToken).toMatch(DATASET_TOKEN_RE);
    expect(row.approvedAt).toBeInstanceOf(Date);
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.reviewNote).toBe("looks legitimate");
    expectNearTerm(row.expiresAt, before);
  });

  it("a second approve is not_eligible and leaves the token untouched", async () => {
    const g = await pendingGrant();
    await approve(g.id);
    const { accessTokenHash, expiresAt } = await rowById(g.id);

    expect(await approveDatasetGrant(g.id)).toStrictEqual(NOT_ELIGIBLE);

    const after = await rowById(g.id);
    expect(after.accessTokenHash).toBe(accessTokenHash);
    expect(after.expiresAt).toEqual(expiresAt);
  });

  it("two concurrent approves mint exactly one token", async () => {
    const g = await pendingGrant();

    // PGlite serialises queries: this proves the WHERE guard, not real interleaving.
    const results = await Promise.all([approveDatasetGrant(g.id), approveDatasetGrant(g.id)]);

    const approved = results.filter((r) => r.ok && r.kind === "approved");
    expect(approved).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([NOT_ELIGIBLE]);
    const winner = approved[0];
    if (!winner.ok || winner.kind !== "approved") throw new Error("unreachable");
    expect((await rowById(g.id)).accessTokenHash).toBe(hashToken(winner.mail.accessToken));
  });

  it.each(["unverified", "rejected", "revoked", "expired"] as const)("%s is not_eligible and unchanged", async (status) => {
    const g = await insertGrant({ status });

    expect(await approveDatasetGrant(g.id)).toStrictEqual(NOT_ELIGIBLE);

    const row = await rowById(g.id);
    expect(row.status).toBe(status);
    expect(row.accessTokenHash).toBeNull();
    expect(row.approvedAt).toBeNull();
  });

  it("approves a renewal: extends expiry, clears the renewal fields, keeps the access token, returns no token", async () => {
    const { row: g, accessToken } = await activeGrant({
      expiresAt: new Date(Date.now() + DAY_MS),
      renewalRequestedAt: new Date(),
      renewalRemindedAt: new Date(),
      renewTokenHash: hashToken("renew-1"),
      reviewNote: "first approval",
    });
    const before = Date.now();

    const result = await approveDatasetGrant(g.id, { reviewNote: "renewal ok" });

    expect(result).toStrictEqual({ ok: true, kind: "renewed" });
    const row = await rowById(g.id);
    expect(row.status).toBe("active");
    expect(row.accessTokenHash).toBe(hashToken(accessToken));
    expectNearTerm(row.expiresAt, before);
    expect(row.renewalRequestedAt).toBeNull();
    expect(row.renewalRemindedAt).toBeNull();
    expect(row.renewTokenHash).toBeNull();
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.reviewedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.reviewNote).toBe("renewal ok"); // a new note replaces the first approval's
  });

  it.each([
    ["no opts", undefined],
    ["an empty note", { reviewNote: "" }],
    ["a whitespace-only note", { reviewNote: "   " }],
  ])("approving a renewal with %s keeps the existing reviewNote and still stamps reviewedAt", async (_label, opts) => {
    const oldReview = new Date(Date.now() - 30 * DAY_MS);
    const { row: g } = await activeGrant({
      expiresAt: new Date(Date.now() + DAY_MS),
      renewalRequestedAt: new Date(),
      reviewedAt: oldReview,
      reviewNote: "first approval",
    });
    const before = Date.now();

    expect(await approveDatasetGrant(g.id, opts)).toStrictEqual({ ok: true, kind: "renewed" });

    const row = await rowById(g.id);
    expect(row.reviewNote).toBe("first approval");
    expect(row.reviewedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.renewalRequestedAt).toBeNull();
    expectNearTerm(row.expiresAt, before);
  });
});

describe("rejectDatasetGrant", () => {
  it("moves pending_review to rejected, stores both notes and returns the mail carrying the rejection note", async () => {
    const g = await pendingGrant();

    const result = await rejectDatasetGrant(g.id, { reviewNote: " internal ", rejectionNote: " Not a fit. " });

    expect(result).toStrictEqual({
      ok: true,
      mail: { kind: "dataset_rejected", grantId: g.id, email: "reporter@example.com", rejectionNote: "Not a fit." },
    });
    const row = await rowById(g.id);
    expect(row.status).toBe("rejected");
    expect(row.reviewNote).toBe("internal");
    expect(row.rejectionNote).toBe("Not a fit.");
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.accessTokenHash).toBeNull();
  });

  it("empty or missing notes become null", async () => {
    const a = await pendingGrant({ email: "a@example.com" });
    const b = await pendingGrant({ email: "b@example.com" });

    const ra = await rejectDatasetGrant(a.id, { reviewNote: "   ", rejectionNote: "" });
    const rb = await rejectDatasetGrant(b.id);

    for (const r of [ra, rb]) {
      expect(r.ok && r.mail.rejectionNote).toBeNull();
    }
    for (const id of [a.id, b.id]) {
      const row = await rowById(id);
      expect(row.reviewNote).toBeNull();
      expect(row.rejectionNote).toBeNull();
    }
  });

  it("caps a note at 2000 characters", async () => {
    const g = await pendingGrant();

    const result = await rejectDatasetGrant(g.id, { reviewNote: "r".repeat(2500), rejectionNote: "x".repeat(2500) });

    expect(result.ok && result.mail.rejectionNote).toBe("x".repeat(2000));
    const row = await rowById(g.id);
    expect(row.rejectionNote).toBe("x".repeat(2000));
    expect(row.reviewNote).toBe("r".repeat(2000));
  });

  it.each(["unverified", "active", "rejected", "revoked", "expired"] as const)("%s is not_eligible and unchanged", async (status) => {
    const g = await insertGrant({ status });

    expect(await rejectDatasetGrant(g.id, { rejectionNote: "no" })).toStrictEqual(NOT_ELIGIBLE);

    const row = await rowById(g.id);
    expect(row.status).toBe(status);
    expect(row.rejectionNote).toBeNull();
  });
});

describe("revokeDatasetGrant", () => {
  it("moves active to revoked, keeps the token hash, and the old link then resolves inactive", async () => {
    const { row: g, accessToken } = await activeGrant();
    expect((await getGrantByAccessToken(accessToken)).state).toBe("active");

    const result = await revokeDatasetGrant(g.id, { reason: "  misuse  " });

    expect(result).toStrictEqual({ ok: true });
    const row = await rowById(g.id);
    expect(row.status).toBe("revoked");
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.revokeReason).toBe("misuse");
    expect(row.accessTokenHash).toBe(hashToken(accessToken));
    expect(await getGrantByAccessToken(accessToken)).toStrictEqual({ state: "inactive" });
  });

  it("without a reason stores null; a second revoke and a non-active grant are not_eligible", async () => {
    const { row: g } = await activeGrant();
    expect(await revokeDatasetGrant(g.id)).toStrictEqual({ ok: true });
    expect((await rowById(g.id)).revokeReason).toBeNull();

    expect(await revokeDatasetGrant(g.id)).toStrictEqual(NOT_ELIGIBLE);
    const pending = await pendingGrant();
    expect(await revokeDatasetGrant(pending.id)).toStrictEqual(NOT_ELIGIBLE);
    expect((await rowById(pending.id)).status).toBe("pending_review");
  });
});

describe("reissueDatasetLink", () => {
  it("rotates the token: the old link dies, the new one works, and only the hash is stored", async () => {
    const { row: g, accessToken: oldRaw } = await activeGrant();

    const result = await reissueDatasetLink(g.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mail).toEqual({
      kind: "dataset_link_reissued",
      grantId: g.id,
      email: "reporter@example.com",
      accessToken: expect.stringMatching(DATASET_TOKEN_RE),
    });
    const newRaw = result.mail.accessToken;
    expect(newRaw).not.toBe(oldRaw);
    const row = await rowById(g.id);
    expect(row.accessTokenHash).toBe(hashToken(newRaw));
    expect(JSON.stringify(row)).not.toContain(newRaw);
    expect(await getGrantByAccessToken(oldRaw)).toStrictEqual({ state: "inactive" });
    const resolved = await getGrantByAccessToken(newRaw);
    expect(resolved.state).toBe("active");
  });

  it("a revoked grant is not_eligible", async () => {
    const { row: g } = await activeGrant({ status: "revoked" });
    const { accessTokenHash } = g;

    expect(await reissueDatasetLink(g.id)).toStrictEqual(NOT_ELIGIBLE);
    expect((await rowById(g.id)).accessTokenHash).toBe(accessTokenHash);
  });

  it("an active grant whose expiry has passed is not_eligible", async () => {
    const { row: g } = await activeGrant({ expiresAt: new Date(Date.now() - 1_000) });
    const { accessTokenHash } = g;

    expect(await reissueDatasetLink(g.id)).toStrictEqual(NOT_ELIGIBLE);
    expect((await rowById(g.id)).accessTokenHash).toBe(accessTokenHash);
  });
});

describe("extendDatasetGrant", () => {
  it("sets expiry to now plus the term and clears the renewal fields", async () => {
    const { row: g, accessToken } = await activeGrant({
      expiresAt: new Date(Date.now() + DAY_MS),
      renewalRequestedAt: new Date(),
      renewalRemindedAt: new Date(),
      renewTokenHash: hashToken("renew-2"),
    });
    const before = Date.now();

    expect(await extendDatasetGrant(g.id)).toStrictEqual({ ok: true });

    const row = await rowById(g.id);
    expectNearTerm(row.expiresAt, before);
    expect(row.renewalRequestedAt).toBeNull();
    expect(row.renewalRemindedAt).toBeNull();
    expect(row.renewTokenHash).toBeNull();
    expect(row.accessTokenHash).toBe(hashToken(accessToken));
  });

  it.each(["unverified", "pending_review", "rejected", "revoked", "expired"] as const)("%s is not_eligible and unchanged", async (status) => {
    const g = await insertGrant({ status, expiresAt: new Date(Date.now() + DAY_MS) });

    expect(await extendDatasetGrant(g.id)).toStrictEqual(NOT_ELIGIBLE);
    expect((await rowById(g.id)).expiresAt).toEqual(g.expiresAt);
  });
});

describe("issueRenewalToken and requestRenewal", () => {
  async function issued() {
    const { row: g } = await activeGrant();
    const result = await issueRenewalToken(g.id);
    if (!result.ok) throw new Error("expected a renewal token");
    return { g, renewToken: result.mail.renewToken, mail: result.mail };
  }

  it("issues a token, stores only its hash, and leaves renewalRemindedAt for the cron", async () => {
    const { g, renewToken, mail } = await issued();

    expect(mail).toEqual({
      kind: "dataset_renewal_reminder",
      grantId: g.id,
      email: "reporter@example.com",
      renewToken: expect.stringMatching(DATASET_TOKEN_RE),
    });
    const row = await rowById(g.id);
    expect(row.renewTokenHash).toMatch(HEX64);
    expect(row.renewTokenHash).toBe(hashToken(renewToken));
    expect(JSON.stringify(row)).not.toContain(renewToken);
    expect(row.renewalRemindedAt).toBeNull();
  });

  it("is not_eligible for a grant that is not active", async () => {
    for (const status of ["unverified", "pending_review", "rejected", "revoked", "expired"] as const) {
      const g = await insertGrant({ status, email: `${status}@example.com` }); // one open row per email
      expect(await issueRenewalToken(g.id)).toStrictEqual(NOT_ELIGIBLE);
      expect((await rowById(g.id)).renewTokenHash).toBeNull();
    }
  });

  it("the first request sets the timestamp; a repeat is requested and leaves it unchanged", async () => {
    const { g, renewToken } = await issued();

    expect(await requestRenewal(renewToken)).toStrictEqual({ outcome: "requested" });
    const first = (await rowById(g.id)).renewalRequestedAt;
    expect(first).toBeInstanceOf(Date);

    // Pin the stamp to a past instant so a re-stamp cannot hide inside the same millisecond.
    const pinned = new Date(Date.now() - DAY_MS);
    await tdb.db.update(datasetAccessGrantsTable).set({ renewalRequestedAt: pinned });

    expect(await requestRenewal(renewToken)).toStrictEqual({ outcome: "requested" });
    expect((await rowById(g.id)).renewalRequestedAt).toEqual(pinned);
  });

  it("a malformed token is invalid and never touches the database", async () => {
    getDbMock().mockClear();
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`]) {
      expect(await requestRenewal(bad)).toStrictEqual({ outcome: "invalid" });
    }
    expect(getDbMock()).not.toHaveBeenCalled();
  });

  it("an unknown well-formed token is invalid", async () => {
    await issued();
    expect(await requestRenewal(generateToken())).toStrictEqual({ outcome: "invalid" });
  });

  it("a revoked grant's renew token is invalid and the timestamp stays null", async () => {
    const { g, renewToken } = await issued();
    await revokeDatasetGrant(g.id);

    expect(await requestRenewal(renewToken)).toStrictEqual({ outcome: "invalid" });
    expect((await rowById(g.id)).renewalRequestedAt).toBeNull();
  });

  it("a second issue replaces the first token", async () => {
    const { g, renewToken: first } = await issued();
    const second = await issueRenewalToken(g.id);
    if (!second.ok) throw new Error("expected a renewal token");

    expect(await requestRenewal(first)).toStrictEqual({ outcome: "invalid" });
    expect((await rowById(g.id)).renewalRequestedAt).toBeNull();
    expect(await requestRenewal(second.mail.renewToken)).toStrictEqual({ outcome: "requested" });
  });
});

describe("getGrantByAccessToken", () => {
  it("every inactive case returns the identical { state: 'inactive' }", async () => {
    const results: unknown[] = [await getGrantByAccessToken(generateToken())]; // unknown
    for (const status of ["unverified", "pending_review", "rejected", "revoked", "expired"] as const) {
      const raw = generateToken();
      // Seeded WITH a matching hash so the lookup finds the row and only the status gate says no.
      await insertGrant({
        status,
        email: `${status}@example.com`, // one open row per email
        accessTokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + DAY_MS),
      });
      results.push(await getGrantByAccessToken(raw));
    }
    for (const bad of ["", "short", "a".repeat(44)]) results.push(await getGrantByAccessToken(bad)); // malformed

    expect(results).toHaveLength(9);
    for (const r of results) expect(r).toStrictEqual({ state: "inactive" });
  });

  it("a malformed token never touches the database", async () => {
    getDbMock().mockClear();
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`]) {
      expect(await getGrantByAccessToken(bad)).toStrictEqual({ state: "inactive" });
    }
    expect(getDbMock()).not.toHaveBeenCalled();
  });

  it("an active grant past its expiry is inactive and its status is lazily set to expired", async () => {
    const { row: g, accessToken } = await activeGrant({ expiresAt: new Date(Date.now() - 1_000) });

    expect(await getGrantByAccessToken(accessToken)).toStrictEqual({ state: "inactive" });

    expect((await rowById(g.id)).status).toBe("expired");
  });

  it("an active grant with no expiry is LAPSED: inactive and lazily set to expired", async () => {
    const { row: g, accessToken } = await activeGrant({ expiresAt: null });

    expect(await getGrantByAccessToken(accessToken)).toStrictEqual({ state: "inactive" });

    expect((await rowById(g.id)).status).toBe("expired");
  });

  it("an active, unexpired grant resolves to its id, name, organization, expiry, tier and subscription flag", async () => {
    const { row: g, accessToken } = await activeGrant({ name: "Pat Reporter", organization: "The Gazette" });

    const result = await getGrantByAccessToken(accessToken);

    expect(result).toStrictEqual({
      state: "active",
      grant: {
        id: g.id,
        name: "Pat Reporter",
        organization: "The Gazette",
        expiresAt: g.expiresAt,
        tier: "free",
        hasSubscription: false,
      },
    });
  });

  it("never returns the PayPal subscription id, only a strict boolean saying one exists", async () => {
    const { accessToken } = await activeGrant({
      tier: "commercial",
      category: "commercial",
      paidThrough: daysFromNow(10),
      paypalSubscriptionId: "I-SECRET123",
    });

    const result = await getGrantByAccessToken(accessToken);

    expect(result.state).toBe("active");
    if (result.state !== "active") return;
    expect(result.grant.tier).toBe("commercial");
    expect(result.grant.hasSubscription).toBe(true);
    const serialised = JSON.stringify(result);
    for (const secret of ["I-SECRET123", "paypal_subscription_id", "paypalSubscriptionId"]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("hands back exactly the DatasetActiveGrant keys: no hash, raw token, email, IP hash or note", async () => {
    const { row: g, accessToken } = await activeGrant({
      organization: null,
      reviewNote: "internal note",
      rejectionNote: "internal rejection",
      submitterIpHash: "iphash-secret",
      unsubscribeToken: generateToken(),
      renewTokenHash: hashToken("renew-key-set"),
    });

    const result = await getGrantByAccessToken(accessToken);

    expect(result.state).toBe("active");
    if (result.state !== "active") return;
    expect(Object.keys(result.grant).sort()).toEqual(["expiresAt", "hasSubscription", "id", "name", "organization", "tier"]);
    expect(result.grant.organization).toBeNull();
    expect(result.grant.hasSubscription).toBe(false);
    const serialised = JSON.stringify(result);
    for (const secret of [g.email, g.accessTokenHash, g.verifyTokenHash, g.renewTokenHash, g.unsubscribeToken, "iphash-secret", "internal"]) {
      expect(serialised).not.toContain(secret as string);
    }
  });

  // `live` is a computed sql<boolean>, so the driver's raw value reaches the gate unmapped. Only a real `true` may open it.
  it.each(["f", "false", "t", 1])(
    "a revoked grant stays inactive even when the `live` projection is mis-parsed as %j",
    async (bad) => {
      const { row: g, accessToken } = await activeGrant({
        status: "revoked",
        revokedAt: new Date(),
        expiresAt: daysFromNow(30), // revoking keeps the date, so only the status says no
      });
      const mis = misparsedProjection("live", bad);
      try {
        expect(await getGrantByAccessToken(accessToken)).toStrictEqual({ state: "inactive" });
      } finally {
        mis.spy.mockRestore();
      }
      expect(mis.rewrites()).toBe(1); // the spy really did replace the projection
      expect((await rowById(g.id)).status).toBe("revoked");
    }
  );

  it("a lapsed grant stays inactive when the `live` projection is mis-parsed as 'f', and the SQL-guarded lazy expiry still runs", async () => {
    const { row: g, accessToken } = await activeGrant({ expiresAt: daysFromNow(-1) });
    const mis = misparsedProjection("live", "f");
    try {
      expect(await getGrantByAccessToken(accessToken)).toStrictEqual({ state: "inactive" });
    } finally {
      mis.spy.mockRestore();
    }
    expect(mis.rewrites()).toBe(1);
    expect((await rowById(g.id)).status).toBe("expired");
  });

  it("a failed lazy expiry is best effort: still inactive, logged by SQLSTATE only, nothing sensitive in the log", async () => {
    const { row: g, accessToken } = await activeGrant({ expiresAt: daysFromNow(-1) });
    const update = vi.spyOn(tdb.db, "update").mockImplementation((() => {
      // The shape of a drizzle wrapper: the message embeds the bound params, the driver code sits on `cause`.
      throw new Error(`Failed query: update "dataset_access_grants" params: ${accessToken},${g.email}`, {
        cause: Object.assign(new Error("connection terminated"), { code: "08006" }),
      });
    }) as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await getGrantByAccessToken(accessToken)).toStrictEqual({ state: "inactive" });

      expect(log).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain("dataset lazy expiry failed");
      expect(logged).toContain("08006");
      for (const secret of [accessToken, hashToken(accessToken), g.email, "Failed query"]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      update.mockRestore();
      log.mockRestore();
    }
    expect((await rowById(g.id)).status).toBe("active"); // the sweep catches it later
  });
});

describe("expireDueGrants", () => {
  it("expires LAPSED grants (due at or before now, or no expiry), touches nothing else, and returns the count", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    // One open row per email, so each open row gets its own address.
    const dueAtNow = await insertGrant({ email: "due-at-now@example.com", status: "active", expiresAt: now });
    const dueBefore = await insertGrant({
      email: "due-before@example.com",
      status: "active",
      expiresAt: new Date(now.getTime() - 1_000),
    });
    const future = await insertGrant({
      email: "future@example.com",
      status: "active",
      expiresAt: new Date(now.getTime() + 1_000),
    });
    const noExpiry = await insertGrant({ email: "no-expiry@example.com", status: "active", expiresAt: null });
    const renewalPending = await insertGrant({
      email: "renewal-pending@example.com",
      status: "active",
      expiresAt: new Date(now.getTime() - DAY_MS),
      renewalRequestedAt: new Date(now.getTime() - 5 * DAY_MS),
    });
    const revoked = await insertGrant({ status: "revoked", expiresAt: new Date(now.getTime() - DAY_MS) });
    const pending = await insertGrant({
      email: "pending@example.com",
      status: "pending_review",
      expiresAt: new Date(now.getTime() - DAY_MS),
    });

    expect(await expireDueGrants(now)).toBe(3);

    const statusOf = async (id: string) => (await rowById(id)).status;
    expect(await statusOf(dueAtNow.id)).toBe("expired");
    expect(await statusOf(dueBefore.id)).toBe("expired");
    expect(await statusOf(noExpiry.id)).toBe("expired"); // NULL expiry is lapsed
    expect(await statusOf(future.id)).toBe("active");
    expect(await statusOf(renewalPending.id)).toBe("active"); // past expiry, but a renewal was requested in time
    expect(await statusOf(revoked.id)).toBe("revoked");
    expect(await statusOf(pending.id)).toBe("pending_review");
    expect(await expireDueGrants(now)).toBe(0);
  });

  it("defaults now to the current time", async () => {
    const due = await insertGrant({ status: "active", expiresAt: new Date(Date.now() - 1_000) });
    expect(await expireDueGrants()).toBe(1);
    expect((await rowById(due.id)).status).toBe("expired");
  });
});

// ---- One lifecycle rule ----

/**
 * LIVE, RENEWAL_PENDING and LAPSED (`liveGrant`, `renewalPendingGrant`, `lapsedGrant` in
 * lib/dataset-grants.ts) must mean the same thing in EVERY function. Each key below is a state an
 * `active` grant can be in; `expected` is what each function must do to it. Ed, 2026-11-09: "a renewal
 * requested before expiry stays approvable after the date passes; downloads pause at expiry until
 * approved". A grant with a NULL expiry is unreachable through `approveDatasetGrant` but is LAPSED
 * everywhere, so it gets a row of its own.
 */
type LifecycleState = "LIVE" | "RENEWAL_PENDING past expiry" | "LAPSED past expiry" | "LAPSED null expiry";

interface LifecycleExpectation {
  /** getGrantByAccessToken's answer; the lookup also marks a LAPSED row `expired`. */
  lookup: "active" | "inactive";
  /** LAPSED: the lookup, the sweep and a new request from the same address all mark the row `expired`. */
  lapsed: boolean;
  requestRenewal: "requested" | "invalid";
  issueRenewalToken: boolean;
  extend: boolean;
  approveRenewal: boolean;
  reissue: boolean;
  revoke: boolean;
  /** What a NEW request from the grant's own address gets: the already-active mail, or a fresh verify mail on a new row. */
  newRequest: "dataset_already_active" | "dataset_verify";
}

const LIFECYCLE: Record<LifecycleState, { seed: () => GrantInsert; expected: LifecycleExpectation }> = {
  LIVE: {
    seed: () => ({ expiresAt: daysFromNow(30) }),
    expected: {
      lookup: "active",
      lapsed: false,
      requestRenewal: "requested",
      issueRenewalToken: true,
      extend: true,
      approveRenewal: false, // nothing was requested
      reissue: true,
      revoke: true,
      newRequest: "dataset_already_active",
    },
  },
  "RENEWAL_PENDING past expiry": {
    seed: () => ({ expiresAt: daysFromNow(-1), renewalRequestedAt: daysFromNow(-5) }),
    expected: {
      lookup: "inactive", // downloads pause...
      lapsed: false, // ...but the row stays active and approvable
      requestRenewal: "requested", // the idempotent repeat: it was requested in time
      issueRenewalToken: false,
      extend: true,
      approveRenewal: true,
      reissue: false,
      revoke: true,
      newRequest: "dataset_already_active",
    },
  },
  "LAPSED past expiry": {
    seed: () => ({ expiresAt: daysFromNow(-1) }),
    expected: {
      lookup: "inactive",
      lapsed: true,
      requestRenewal: "invalid", // too late: a renewal must be requested before expiry
      issueRenewalToken: false,
      extend: false,
      approveRenewal: false,
      reissue: false,
      revoke: true,
      newRequest: "dataset_verify",
    },
  },
  "LAPSED null expiry": {
    seed: () => ({ expiresAt: null }),
    expected: {
      lookup: "inactive",
      lapsed: true,
      requestRenewal: "invalid",
      issueRenewalToken: false,
      extend: false,
      approveRenewal: false,
      reissue: false,
      revoke: true,
      newRequest: "dataset_verify",
    },
  },
};

describe.each(Object.entries(LIFECYCLE))("lifecycle: %s", (_state, { seed, expected }) => {
  const statusAfter = () => (expected.lapsed ? "expired" : "active");

  it("getGrantByAccessToken", async () => {
    const { row, accessToken } = await activeGrant(seed());

    expect((await getGrantByAccessToken(accessToken)).state).toBe(expected.lookup);

    expect((await rowById(row.id)).status).toBe(statusAfter());
  });

  it("expireDueGrants", async () => {
    const { row } = await activeGrant(seed());

    expect(await expireDueGrants()).toBe(expected.lapsed ? 1 : 0);

    expect((await rowById(row.id)).status).toBe(statusAfter());
  });

  it("requestRenewal", async () => {
    const renewToken = generateToken();
    const { row } = await activeGrant({ ...seed(), renewTokenHash: hashToken(renewToken) });

    expect(await requestRenewal(renewToken)).toStrictEqual({ outcome: expected.requestRenewal });

    const { renewalRequestedAt } = await rowById(row.id);
    if (expected.requestRenewal === "invalid") {
      expect(renewalRequestedAt).toBeNull();
    } else {
      expect(renewalRequestedAt).toBeInstanceOf(Date);
      if (row.renewalRequestedAt) expect(renewalRequestedAt).toEqual(row.renewalRequestedAt); // a repeat re-stamps nothing
    }
  });

  it("issueRenewalToken", async () => {
    const { row } = await activeGrant({ ...seed(), renewTokenHash: hashToken("seed-renew") });

    const result = await issueRenewalToken(row.id);

    expect(result.ok).toBe(expected.issueRenewalToken);
    expect((await rowById(row.id)).renewTokenHash).toBe(
      result.ok ? hashToken(result.mail.renewToken) : hashToken("seed-renew")
    );
  });

  it("extendDatasetGrant", async () => {
    const { row } = await activeGrant(seed());

    expect(await extendDatasetGrant(row.id)).toStrictEqual(expected.extend ? { ok: true } : NOT_ELIGIBLE);

    const after = await rowById(row.id);
    if (expected.extend) {
      expectNearTerm(after.expiresAt);
      expect(after.renewalRequestedAt).toBeNull();
    } else {
      expect(after.expiresAt).toEqual(row.expiresAt);
    }
    expect(after.status).toBe("active"); // extending never expires anything, and a refusal changes nothing
  });

  it("approveDatasetGrant (the renewal branch)", async () => {
    const { row, accessToken } = await activeGrant(seed());

    expect(await approveDatasetGrant(row.id)).toStrictEqual(
      expected.approveRenewal ? { ok: true, kind: "renewed" } : NOT_ELIGIBLE
    );

    const after = await rowById(row.id);
    expect(after.status).toBe("active");
    expect(after.accessTokenHash).toBe(hashToken(accessToken)); // never rotated
    if (expected.approveRenewal) {
      expectNearTerm(after.expiresAt);
      expect(after.renewalRequestedAt).toBeNull();
      expect((await getGrantByAccessToken(accessToken)).state).toBe("active"); // the paused link works again
    } else {
      expect(after.expiresAt).toEqual(row.expiresAt);
    }
  });

  it("reissueDatasetLink", async () => {
    const { row } = await activeGrant(seed());

    const result = await reissueDatasetLink(row.id);

    expect(result.ok).toBe(expected.reissue);
    expect((await rowById(row.id)).accessTokenHash).toBe(
      result.ok ? hashToken(result.mail.accessToken) : row.accessTokenHash
    );
  });

  it("revokeDatasetGrant (any expiry)", async () => {
    const { row } = await activeGrant(seed());

    expect(await revokeDatasetGrant(row.id)).toStrictEqual(expected.revoke ? { ok: true } : NOT_ELIGIBLE);

    expect((await rowById(row.id)).status).toBe(expected.revoke ? "revoked" : "active");
  });

  it("requestDatasetAccess from the grant's own address", async () => {
    const { row } = await activeGrant(seed());

    const result = await requestDatasetAccess(body(), "iphash-lifecycle");

    expect(result.ok && result.mail?.kind).toBe(expected.newRequest);
    const rows = await allRows();
    expect((await rowById(row.id)).status).toBe(statusAfter());
    expect(rows).toHaveLength(expected.newRequest === "dataset_verify" ? 2 : 1);
  });
});

describe("renewal grace, end to end", () => {
  // Only `Date` is faked: PGlite and the rest of the event loop keep real timers.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a renewal requested while live stays approvable after the date passes; downloads pause, then the same link works again", async () => {
    const { row, accessToken } = await activeGrant({ expiresAt: daysFromNow(10) });
    const issued = await issueRenewalToken(row.id);
    if (!issued.ok) throw new Error("expected a renewal token");
    const { renewToken } = issued.mail;
    expect((await getGrantByAccessToken(accessToken)).state).toBe("active");
    expect(await requestRenewal(renewToken)).toStrictEqual({ outcome: "requested" }); // in time: the grant is live

    // Time passes beyond expiresAt.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(daysFromNow(11));

    // Downloads pause, but nothing is thrown away: still `active`, the sweep skips it, the repeat still reads "requested".
    expect(await getGrantByAccessToken(accessToken)).toStrictEqual({ state: "inactive" });
    expect((await rowById(row.id)).status).toBe("active");
    expect(await expireDueGrants()).toBe(0);
    expect((await rowById(row.id)).status).toBe("active");
    expect(await requestRenewal(renewToken)).toStrictEqual({ outcome: "requested" });
    expect(await reissueDatasetLink(row.id)).toStrictEqual(NOT_ELIGIBLE); // paused means paused: no new link either

    // Ed approves the renewal (the same call as ever: the renewal branch).
    expect(await approveDatasetGrant(row.id)).toStrictEqual({ ok: true, kind: "renewed" });

    const resumed = await getGrantByAccessToken(accessToken); // the SAME raw token
    expect(resumed.state).toBe("active");
    if (resumed.state !== "active") return;
    expect(resumed.grant.id).toBe(row.id);
    expectNearTerm(resumed.grant.expiresAt, Date.now()); // Date.now() is the faked "now"
    const after = await rowById(row.id);
    expect(after.renewalRequestedAt).toBeNull();
    expect(after.renewTokenHash).toBeNull();
    expect(after.accessTokenHash).toBe(hashToken(accessToken));
  });
});

describe("commercial tier: request path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a commercial request before any DB call or mail while the tier is on", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    getDbMock().mockClear();

    const result = await requestDatasetAccess(body({ category: "commercial" }), "iphash-c1");

    expect(result).toStrictEqual({
      ok: false,
      status: 422,
      error: "commercial_requires_subscription",
      path: "/access/commercial",
    });
    expect(getDbMock()).not.toHaveBeenCalled();
    expect(await tdb.db.select().from(datasetAccessGrantsTable)).toHaveLength(0);
  });

  it("refuses a honeypot-tripped commercial request with the same 422, writing nothing", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    const result = await requestDatasetAccess(body({ category: "commercial", website: "http://spam.example" }), "iphash-c4");
    expect(result).toStrictEqual({
      ok: false,
      status: 422,
      error: "commercial_requires_subscription",
      path: "/access/commercial",
    });
    expect(await tdb.db.select().from(datasetAccessGrantsTable)).toHaveLength(0);
  });

  it("still accepts a non-commercial request while the tier is on", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    const result = await requestDatasetAccess(body({ category: "journalist" }), "iphash-c2");
    expect(result.ok).toBe(true);
  });

  it("accepts a commercial request for review when the tier is off, as before", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", undefined);
    const result = await requestDatasetAccess(body({ category: "commercial" }), "iphash-c3");
    expect(result.ok).toBe(true);
    expect(await tdb.db.select().from(datasetAccessGrantsTable)).toHaveLength(1);
  });
});

describe("redirectDatasetGrantToPaid", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("moves pending_review to rejected with the internal marker and returns the redirect mail", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    const g = await pendingGrant();
    const now = new Date("2026-11-10T12:00:00Z");

    const result = await redirectDatasetGrantToPaid(g.id, now);

    expect(result).toStrictEqual({
      ok: true,
      mail: { kind: "dataset_commercial_redirect", grantId: g.id, email: "reporter@example.com" },
    });
    const row = await rowById(g.id);
    expect(row.status).toBe("rejected");
    expect(row.reviewedAt).toEqual(now);
    expect(row.rejectionNote).toBe("Pointed to the paid commercial subscription");
    expect(row.accessTokenHash).toBeNull();
  });

  it("is not eligible when the tier is off, and changes nothing", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", undefined);
    const g = await pendingGrant();
    expect(await redirectDatasetGrantToPaid(g.id)).toStrictEqual(NOT_ELIGIBLE);
    expect((await rowById(g.id)).status).toBe("pending_review");
  });

  it("is not eligible for a grant that is no longer pending_review, and for a non-UUID", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    const g = await pendingGrant();
    expect(await rejectDatasetGrant(g.id)).toMatchObject({ ok: true });
    expect(await redirectDatasetGrantToPaid(g.id)).toStrictEqual(NOT_ELIGIBLE);
    getDbMock().mockClear();
    expect(await redirectDatasetGrantToPaid("not-a-uuid")).toStrictEqual(NOT_ELIGIBLE);
    expect(getDbMock()).not.toHaveBeenCalled();
  });
});
