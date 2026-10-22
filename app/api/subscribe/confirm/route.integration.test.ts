// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { subscriptionsTable } from "@/lib/db/schema";
import { API_RATE_LIMIT_MAX, __resetApiRateLimit } from "@/lib/api-rate-limit";
import { CONSENT_COOKIE_NAME, verifyConsentCookie } from "@/lib/subscribe-consent";
import { hashToken } from "@/lib/token-hash";

// Imported after the mocks above so the mocked modules are in effect.
import { GET, OPTIONS, POST } from "./route";

let tdb: TestDbHandle;

const ORIGINAL_SALT = process.env.CONTRIBUTE_IP_SALT;
const EMAIL = "reader@example.com";
const IP = "203.0.113.9";

beforeAll(async () => {
  // Without a key the consent cookie is never minted (fails closed), so every
  // cookie assertion below would pass vacuously.
  process.env.CONTRIBUTE_IP_SALT = "confirm-route-test-salt";
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  __resetApiRateLimit();
});

afterAll(async () => {
  await tdb.client.close();
  __resetApiRateLimit();
  if (ORIGINAL_SALT === undefined) {
    delete process.env.CONTRIBUTE_IP_SALT;
  } else {
    process.env.CONTRIBUTE_IP_SALT = ORIGINAL_SALT;
  }
});

function confirmReq(token: string, ip: string = IP): Request {
  return new Request(`http://localhost/api/subscribe/confirm?token=${encodeURIComponent(token)}`, {
    headers: { "x-real-ip": ip },
  });
}

function confirmPost(token: string, ip: string = IP): Request {
  return new Request(`http://localhost/api/subscribe/confirm?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "x-real-ip": ip },
  });
}

async function rowStatus(): Promise<string | undefined> {
  const rows = await tdb.db.select().from(subscriptionsTable);
  return rows[0]?.status;
}

/** Seeds a pending row whose raw confirm token is `raw`. */
async function seedPending(raw: string, email: string = EMAIL): Promise<void> {
  await tdb.db.insert(subscriptionsTable).values({
    email,
    targetType: "state",
    targetId: "TN",
    status: "pending",
    confirmToken: hashToken(raw),
    unsubscribeToken: `unsub-${raw}`,
  });
}

/** The `sub_consent` Set-Cookie header on a response, or undefined. */
function consentSetCookie(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${CONSENT_COOKIE_NAME}=`));
}

describe("GET /api/subscribe/confirm — never mutates", () => {
  it("redirects a pending token to the interstitial, leaves the row pending, sets no cookie", async () => {
    await seedPending("good-token");

    const res = await GET(confirmReq("good-token"));

    expect(res.headers.get("location")).toBe("http://localhost/subscribe/confirm?token=good-token");
    expect(consentSetCookie(res)).toBeUndefined();
    expect(await rowStatus()).toBe("pending");
  });

  it("survives repeated prefetch GETs still pending", async () => {
    await seedPending("prefetch-token");
    await GET(confirmReq("prefetch-token"));
    await GET(confirmReq("prefetch-token"));
    expect(await rowStatus()).toBe("pending");
  });

  it("sends an already-confirmed token to /subscribe/confirmed WITH the consent cookie", async () => {
    await seedPending("done-token");
    await POST(confirmPost("done-token"));

    const res = await GET(confirmReq("done-token"));

    expect(res.headers.get("location")).toContain("/subscribe/confirmed");
    const value = consentSetCookie(res)!.slice(`${CONSENT_COOKIE_NAME}=`.length).split(";")[0];
    expect(verifyConsentCookie(value, EMAIL)).toBe(true);
  });

  it("sends invalid and unsubscribed tokens to /subscribe/invalid with no cookie", async () => {
    await seedPending("unsub-token");
    await tdb.db.update(subscriptionsTable).set({ status: "unsubscribed" });

    for (const t of ["nope-not-a-token", "unsub-token"]) {
      const res = await GET(confirmReq(t));
      expect(res.headers.get("location")).toContain("/subscribe/invalid");
      expect(consentSetCookie(res)).toBeUndefined();
    }
    expect(await rowStatus()).toBe("unsubscribed");
  });

  it("peeks a legacy raw stored token without mutating, and the POST then confirms it", async () => {
    await tdb.db.insert(subscriptionsTable).values({
      email: EMAIL,
      targetType: "state",
      targetId: "TN",
      status: "pending",
      confirmToken: "legacy-raw-token",
      unsubscribeToken: "unsub-legacy",
    });

    const res = await GET(confirmReq("legacy-raw-token"));
    expect(res.headers.get("location")).toContain("/subscribe/confirm?token=legacy-raw-token");
    expect(await rowStatus()).toBe("pending");

    const post = await POST(confirmPost("legacy-raw-token"));
    expect(post.headers.get("location")).toContain("/subscribe/confirmed");
    expect(await rowStatus()).toBe("confirmed");
  });

  it("rejects a stored 64-hex hash presented as a token (stolen-hash bypass guard)", async () => {
    await seedPending("hash-guard-token");
    const stored = hashToken("hash-guard-token");

    const get = await GET(confirmReq(stored));
    expect(get.headers.get("location")).toContain("/subscribe/invalid");
    const post = await POST(confirmPost(stored));
    expect(post.headers.get("location")).toContain("/subscribe/invalid");
    expect(await rowStatus()).toBe("pending");
  });
});

describe("POST /api/subscribe/confirm — consent cookie", () => {
  it("confirms, 303s to /subscribe/confirmed, and sets an httpOnly, secure, lax, 30-minute cookie bound to the address", async () => {
    await seedPending("good-token");

    const res = await POST(confirmPost("good-token"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/subscribe/confirmed");
    expect(await rowStatus()).toBe("confirmed");
    const setCookie = consentSetCookie(res);
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=1800");

    const value = setCookie!.slice(`${CONSENT_COOKIE_NAME}=`.length).split(";")[0];
    expect(verifyConsentCookie(value, EMAIL)).toBe(true);
    expect(verifyConsentCookie(value, "someone-else@example.com")).toBe(false);
  });

  it("sets the cookie on a second POST ('already') for the same address", async () => {
    await seedPending("repeat-token");
    expect(consentSetCookie(await POST(confirmPost("repeat-token")))).toBeDefined();

    const second = await POST(confirmPost("repeat-token"));
    expect(second.headers.get("location")).toContain("/subscribe/confirmed");
    const value = consentSetCookie(second)!.slice(`${CONSENT_COOKIE_NAME}=`.length).split(";")[0];
    expect(verifyConsentCookie(value, EMAIL)).toBe(true);
  });

  it("sets no cookie for invalid or unsubscribed tokens, and never re-confirms an unsubscribed row", async () => {
    await seedPending("unsub-token");
    await tdb.db.update(subscriptionsTable).set({ status: "unsubscribed" });

    for (const t of ["nope-not-a-token", "unsub-token"]) {
      const res = await POST(confirmPost(t));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("/subscribe/invalid");
      expect(consentSetCookie(res)).toBeUndefined();
    }
    expect(await rowStatus()).toBe("unsubscribed");
  });

  it("sets no cookie when no signing key is configured (fails closed, redirect unchanged)", async () => {
    await seedPending("keyless-token");
    delete process.env.CONTRIBUTE_IP_SALT;
    try {
      const res = await POST(confirmPost("keyless-token"));

      expect(res.headers.get("location")).toContain("/subscribe/confirmed");
      expect(consentSetCookie(res)).toBeUndefined();
    } finally {
      process.env.CONTRIBUTE_IP_SALT = "confirm-route-test-salt";
    }
  });

  it("answers a DB error with a 303 to /subscribe/invalid and logs no address or token", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(dbClient.getDb).mockImplementationOnce(() => {
      throw Object.assign(new Error(`Failed query: params: ${EMAIL} secret-token`), { code: "08006" });
    });
    try {
      const res = await POST(confirmPost("secret-token"));
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("/subscribe/invalid");
      expect(consentSetCookie(res)).toBeUndefined();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("cdn-cache-control")).toBe("no-store");
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain("08006");
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain("secret-token");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /api/subscribe/confirm — DB error", () => {
  it("redirects to /subscribe/invalid, no cookie, no-store, and logs no address or token", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(dbClient.getDb).mockImplementationOnce(() => {
      throw Object.assign(new Error(`Failed query: params: ${EMAIL} secret-token`), { code: "08006" });
    });
    try {
      const res = await GET(confirmReq("secret-token"));
      expect(res.headers.get("location")).toContain("/subscribe/invalid");
      expect(consentSetCookie(res)).toBeUndefined();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("cdn-cache-control")).toBe("no-store");
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain("08006");
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain("secret-token");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("confirm compare-and-set", () => {
  it("does not re-confirm a row unsubscribed between the lookup and the update", async () => {
    await seedPending("race-token");
    // Unsubscribe lands right after the lookup read the row as pending.
    const real = tdb.db.update.bind(tdb.db);
    const spy = vi.spyOn(tdb.db, "update").mockImplementationOnce(((table: never) => ({
      set: (vals: never) => ({
        where: (cond: never) => ({
          returning: async (cols: never) => {
            await tdb.db.update(subscriptionsTable).set({ status: "unsubscribed" });
            return (
              real(table).set(vals).where(cond) as unknown as {
                returning: (c: never) => Promise<unknown[]>;
              }
            ).returning(cols);
          },
        }),
      }),
    })) as never);
    try {
      const res = await POST(confirmPost("race-token"));
      expect(res.headers.get("location")).toContain("/subscribe/invalid");
      expect(consentSetCookie(res)).toBeUndefined();
      expect(await rowStatus()).toBe("unsubscribed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("OPTIONS /api/subscribe/confirm", () => {
  it("answers the public-write preflight", async () => {
    expect(OPTIONS().status).toBeLessThan(300);
  });
});

// Prod (2026-09-27) served these redirects with `public, max-age=14400` supplied
// by Cloudflare, because the origin sent no directive — caching a single-use
// token's outcome for 4 hours.
describe("/api/subscribe/confirm — uncacheable", () => {
  it.each([
    ["a valid token", "cacheable-token", true],
    ["an invalid token", "no-such-token", false],
  ])("sends both no-store headers for %s", async (_label, token, seed) => {
    if (seed) await seedPending(token);

    for (const res of [await GET(confirmReq(token)), await POST(confirmPost(token))]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    }
  });
});

describe("POST /api/subscribe/confirm — rate limit", () => {
  it(`429s a POST after ${API_RATE_LIMIT_MAX} requests from one IP, with both no-store headers`, async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      expect((await POST(confirmPost("burst-token"))).status).toBe(303);
    }
    const limited = await POST(confirmPost("burst-token"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("cdn-cache-control")).toBe("no-store");
  });
});

describe("GET /api/subscribe/confirm — rate limit", () => {
  it(`429s after ${API_RATE_LIMIT_MAX} requests from one IP, with both no-store headers`, async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      const ok = await GET(confirmReq("burst-token"));
      expect(ok.status).toBe(307);
    }

    const limited = await GET(confirmReq("burst-token"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("counts per IP — a different IP is unaffected by another's burst", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX + 1; i++) {
      await GET(confirmReq("burst-token", "198.51.100.1"));
    }

    const other = await GET(confirmReq("burst-token", "198.51.100.2"));
    expect(other.status).toBe(307);
  });

  // Namespaced buckets: a subscriber's single click must not be refused because
  // the same IP was browsing the read API, which keys on the bare IP.
  it("does not share a bucket with the bare-IP key used by the read API", async () => {
    const { checkApiRateLimit } = await import("@/lib/api-rate-limit");
    for (let i = 0; i < API_RATE_LIMIT_MAX + 1; i++) {
      checkApiRateLimit(IP);
    }

    const res = await GET(confirmReq("post-readapi-token"));
    expect(res.status).toBe(307);
  });
});
