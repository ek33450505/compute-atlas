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
import { GET } from "./route";

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

describe("GET /api/subscribe/confirm — consent cookie", () => {
  it("sets an httpOnly, secure, lax, 30-minute cookie that verifies for the confirmed address", async () => {
    await seedPending("good-token");

    const res = await GET(confirmReq("good-token"));

    expect(res.headers.get("location")).toContain("/subscribe/confirmed");
    const setCookie = consentSetCookie(res);
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=1800");

    const value = setCookie!.slice(`${CONSENT_COOKIE_NAME}=`.length).split(";")[0];
    expect(verifyConsentCookie(value, EMAIL)).toBe(true);
    // Bound to the confirmed address, not a bare "someone confirmed" flag.
    expect(verifyConsentCookie(value, "someone-else@example.com")).toBe(false);
  });

  // Mail clients and link scanners prefetch URLs, consuming the one-time
  // "confirmed" outcome before the human clicks — so the human's own click
  // answers "already", and must still receive the cookie.
  it("sets the cookie on a repeat confirm of the same token ('already'), for the same address", async () => {
    await seedPending("repeat-token");

    const first = await GET(confirmReq("repeat-token"));
    expect(consentSetCookie(first)).toBeDefined();

    const second = await GET(confirmReq("repeat-token"));
    expect(second.headers.get("location")).toContain("/subscribe/confirmed");
    const value = consentSetCookie(second)!
      .slice(`${CONSENT_COOKIE_NAME}=`.length)
      .split(";")[0];
    expect(verifyConsentCookie(value, EMAIL)).toBe(true);
  });

  it("sets no cookie for an invalid token", async () => {
    const res = await GET(confirmReq("nope-not-a-token"));

    expect(res.headers.get("location")).toContain("/subscribe/invalid");
    expect(consentSetCookie(res)).toBeUndefined();
  });

  it("sets no cookie when no signing key is configured (fails closed, redirect unchanged)", async () => {
    await seedPending("keyless-token");
    delete process.env.CONTRIBUTE_IP_SALT;
    try {
      const res = await GET(confirmReq("keyless-token"));

      expect(res.headers.get("location")).toContain("/subscribe/confirmed");
      expect(consentSetCookie(res)).toBeUndefined();
    } finally {
      process.env.CONTRIBUTE_IP_SALT = "confirm-route-test-salt";
    }
  });
});

// Prod (2026-09-27) served these redirects with `public, max-age=14400` supplied
// by Cloudflare, because the origin sent no directive — caching a single-use
// token's outcome for 4 hours.
describe("GET /api/subscribe/confirm — uncacheable", () => {
  it.each([
    ["a valid token", "cacheable-token", true],
    ["an invalid token", "no-such-token", false],
  ])("sends both no-store headers for %s", async (_label, token, seed) => {
    if (seed) await seedPending(token);

    const res = await GET(confirmReq(token));

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
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
