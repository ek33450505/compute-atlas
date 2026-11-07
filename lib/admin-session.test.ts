import { createHash, createHmac } from "node:crypto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  SESSION_MAX_AGE_SECONDS,
  createSessionValue,
  deriveSessionKey,
  verifySessionCookie,
} from "./admin-session";

const TOKEN = "secret-admin-token";

/**
 * Issues a v3 cookie as if `createSessionValue` had been called at
 * `issuedAtMs`, without actually sleeping — fake-time the clock for the
 * single call that reads it, then restore real time immediately so the
 * rest of the test (and `verifySessionCookie`'s own expiry check) sees the
 * real "now".
 */
function makeV3CookieAt(issuedAtMs: number, token = TOKEN): string {
  vi.useFakeTimers();
  vi.setSystemTime(issuedAtMs);
  try {
    return createSessionValue(token);
  } finally {
    vi.useRealTimers();
  }
}

function legacyHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function setPart(cookie: string, index: number, value: string): string {
  const parts = cookie.split(".");
  parts[index] = value;
  return parts.join(".");
}

/** Flips the leading hex digit so the result is guaranteed to differ from
 * the input while staying the same length and a valid hex string — this
 * exercises the HMAC *comparison* itself rather than accidentally tripping
 * a length/format check instead. */
function flipFirstHexChar(hex: string): string {
  const first = hex[0];
  return (first === "a" ? "b" : "a") + hex.slice(1);
}

describe("admin-session", () => {
  const ORIGINAL_TOKEN = process.env.API_ADMIN_TOKEN;

  beforeEach(() => {
    process.env.API_ADMIN_TOKEN = TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ADMIN_SESSION_EPOCH;
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.API_ADMIN_TOKEN;
    } else {
      process.env.API_ADMIN_TOKEN = ORIGINAL_TOKEN;
    }
  });

  describe("v3 cookies", () => {
    it("verifies a freshly issued cookie", () => {
      const cookie = createSessionValue(TOKEN);
      expect(cookie.startsWith("v3.")).toBe(true);
      expect(verifySessionCookie(cookie)).toBe(true);
    });

    it("rejects an expired cookie (issuedAt older than the max age)", () => {
      const issuedAtMs = Date.now() - (SESSION_MAX_AGE_SECONDS * 1000 + 60_000);
      const cookie = makeV3CookieAt(issuedAtMs);
      expect(verifySessionCookie(cookie)).toBe(false);
    });

    it("accepts a cookie safely inside the max age window", () => {
      const issuedAtMs = Date.now() - (SESSION_MAX_AGE_SECONDS * 1000 - 60_000);
      const cookie = makeV3CookieAt(issuedAtMs);
      expect(verifySessionCookie(cookie)).toBe(true);
    });

    it("rejects a tampered issuedAt", () => {
      const cookie = createSessionValue(TOKEN);
      const parts = cookie.split(".");
      const tampered = setPart(cookie, 1, String(Number(parts[1]) - 5000));
      expect(verifySessionCookie(tampered)).toBe(false);
    });

    it("rejects a tampered nonce", () => {
      const cookie = createSessionValue(TOKEN);
      const parts = cookie.split(".");
      const tampered = setPart(cookie, 2, flipFirstHexChar(parts[2]));
      expect(verifySessionCookie(tampered)).toBe(false);
    });

    it("rejects a tampered HMAC", () => {
      const cookie = createSessionValue(TOKEN);
      const parts = cookie.split(".");
      const tampered = setPart(cookie, 3, flipFirstHexChar(parts[3]));
      expect(verifySessionCookie(tampered)).toBe(false);
    });

    it("rejects a truncated HMAC", () => {
      const cookie = createSessionValue(TOKEN);
      const parts = cookie.split(".");
      const truncated = setPart(cookie, 3, parts[3].slice(0, 10));
      expect(verifySessionCookie(truncated)).toBe(false);
    });

    it("rejects a future-dated cookie beyond clock-skew tolerance", () => {
      const issuedAtMs = Date.now() + 60 * 60 * 1000; // 1 hour ahead
      const cookie = makeV3CookieAt(issuedAtMs);
      expect(verifySessionCookie(cookie)).toBe(false);
    });

    it("accepts a cookie within clock-skew tolerance", () => {
      const issuedAtMs = Date.now() + 60 * 1000; // 1 minute ahead
      const cookie = makeV3CookieAt(issuedAtMs);
      expect(verifySessionCookie(cookie)).toBe(true);
    });

    it("rejects a non-numeric issuedAt", () => {
      const cookie = createSessionValue(TOKEN);
      const tampered = setPart(cookie, 1, "not-a-number");
      expect(verifySessionCookie(tampered)).toBe(false);
    });

    it("rejects a signed/negative issuedAt", () => {
      const cookie = createSessionValue(TOKEN);
      const parts = cookie.split(".");
      const tampered = setPart(cookie, 1, `-${parts[1]}`);
      expect(verifySessionCookie(tampered)).toBe(false);
    });

    it("rejects an overflowing issuedAt", () => {
      const cookie = createSessionValue(TOKEN);
      const tampered = setPart(cookie, 1, "9".repeat(400));
      expect(verifySessionCookie(tampered)).toBe(false);
    });

    it("rejects malformed values with the wrong number of parts", () => {
      expect(verifySessionCookie("v3.123.abc")).toBe(false);
      expect(verifySessionCookie("v3.123.abc.def.extra")).toBe(false);
    });

    it("rejects a well-formed cookie signed with a different token", () => {
      // Mint a cookie the normal way — real version, real issuedAt, real
      // random nonce — but with a token that isn't the real
      // API_ADMIN_TOKEN. Structurally this is indistinguishable from a
      // genuine cookie; only the signing key is wrong.
      const attackerCookie = createSessionValue("attacker-token");
      const [version, issuedAtRaw, nonce] = attackerCookie.split(".");

      // Recompute the HMAC over the identical signed input using the REAL
      // token, so the only difference between this cookie and the one above
      // is the signing key — this rules out the rejection above being a
      // vacuous pass from a format/length mismatch rather than the HMAC
      // comparison actually doing its job.
      const realHmac = createHmac("sha256", deriveSessionKey(TOKEN))
        .update(`${version}.${issuedAtRaw}.${nonce}`)
        .digest("hex");
      const realCookie = `${version}.${issuedAtRaw}.${nonce}.${realHmac}`;

      expect(verifySessionCookie(realCookie)).toBe(true);
      expect(verifySessionCookie(attackerCookie)).toBe(false);
    });
  });

  describe("key separation, epoch and retired v2", () => {
    function signWith(key: string | Buffer, version: string, issuedAt: number, nonce: string): string {
      const hmac = createHmac("sha256", key).update(`${version}.${issuedAt}.${nonce}`).digest("hex");
      return `${version}.${issuedAt}.${nonce}.${hmac}`;
    }
    const NONCE = "0123456789abcdef0123456789abcdef";

    it("rejects a cookie HMAC'd with the raw token as key (regression guard for key separation)", () => {
      const raw = signWith(TOKEN, "v3", Date.now(), NONCE);
      expect(verifySessionCookie(raw)).toBe(false);
      // Control: same input signed with the derived key verifies.
      expect(verifySessionCookie(signWith(deriveSessionKey(TOKEN), "v3", Date.now(), NONCE))).toBe(true);
    });

    it("rejects a v2 cookie signed the old way (raw token key)", () => {
      expect(verifySessionCookie(signWith(TOKEN, "v2", Date.now(), NONCE))).toBe(false);
    });

    it("invalidates outstanding sessions when ADMIN_SESSION_EPOCH changes", () => {
      const cookie = createSessionValue(TOKEN);
      expect(verifySessionCookie(cookie)).toBe(true);
      process.env.ADMIN_SESSION_EPOCH = "1";
      expect(verifySessionCookie(cookie)).toBe(false);
      const fresh = createSessionValue(TOKEN);
      expect(verifySessionCookie(fresh)).toBe(true);
      process.env.ADMIN_SESSION_EPOCH = "2";
      expect(verifySessionCookie(fresh)).toBe(false);
      delete process.env.ADMIN_SESSION_EPOCH;
      expect(verifySessionCookie(cookie)).toBe(true); // unset === "0"
    });

    it("treats unset, empty and whitespace epoch as the default", () => {
      const base = deriveSessionKey(TOKEN);
      process.env.ADMIN_SESSION_EPOCH = "  ";
      expect(deriveSessionKey(TOKEN).equals(base)).toBe(true);
      process.env.ADMIN_SESSION_EPOCH = "0";
      expect(deriveSessionKey(TOKEN).equals(base)).toBe(true);
    });

    it("rejects a non-canonical issuedAt (leading zeros) even with a valid HMAC", () => {
      const now = Date.now();
      const padded = `0${now}`;
      expect(verifySessionCookie(signWith(deriveSessionKey(TOKEN), "v3", padded as unknown as number, NONCE))).toBe(false);
      expect(verifySessionCookie(signWith(deriveSessionKey(TOKEN), "v3", now, NONCE))).toBe(true);
    });

    it("derives a key that differs from the token bytes", () => {
      expect(deriveSessionKey(TOKEN).equals(Buffer.from(TOKEN))).toBe(false);
      expect(deriveSessionKey(TOKEN)).toHaveLength(32);
    });
  });

  describe("legacy v1 cookies (retired — see #237)", () => {
    it("rejects a well-formed v1 hash of the correct token", () => {
      expect(verifySessionCookie(legacyHash(TOKEN))).toBe(false);
    });

    it("rejects a v1 hash computed from the wrong token", () => {
      expect(verifySessionCookie(legacyHash("wrong-token"))).toBe(false);
    });
  });

  describe("fail-closed behavior", () => {
    it("rejects garbage input", () => {
      expect(verifySessionCookie("garbage")).toBe(false);
    });

    it("rejects an empty string", () => {
      expect(verifySessionCookie("")).toBe(false);
    });

    it("rejects a missing cookie", () => {
      expect(verifySessionCookie(undefined)).toBe(false);
    });

    it("rejects both cookie formats when API_ADMIN_TOKEN is unset", () => {
      const v3Cookie = createSessionValue(TOKEN);
      const v1Cookie = legacyHash(TOKEN);
      delete process.env.API_ADMIN_TOKEN;
      expect(verifySessionCookie(v3Cookie)).toBe(false);
      expect(verifySessionCookie(v1Cookie)).toBe(false);
    });
  });
});

const { mockGetCookie } = vi.hoisted(() => ({ mockGetCookie: vi.fn() }));

describe("hasAdminSession", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      cookies: vi.fn(async () => ({ get: mockGetCookie })),
    }));
    process.env.API_ADMIN_TOKEN = TOKEN;
    mockGetCookie.mockReset();
  });

  afterEach(() => {
    vi.doUnmock("next/headers");
    delete process.env.API_ADMIN_TOKEN;
  });

  function load() {
    return import("./admin-session");
  }

  it("is true for a valid session cookie", async () => {
    const { createSessionValue, hasAdminSession } = await load();
    mockGetCookie.mockReturnValue({ value: createSessionValue(TOKEN) });
    expect(await hasAdminSession()).toBe(true);
  });

  it("is false when the cookie is missing", async () => {
    mockGetCookie.mockReturnValue(undefined);
    expect(await (await load()).hasAdminSession()).toBe(false);
  });

  it("is false for an invalid cookie", async () => {
    mockGetCookie.mockReturnValue({ value: "garbage" });
    expect(await (await load()).hasAdminSession()).toBe(false);
  });

  it("is false when cookies() throws", async () => {
    mockGetCookie.mockImplementation(() => {
      throw new Error("outside request scope");
    });
    expect(await (await load()).hasAdminSession()).toBe(false);
  });
});
