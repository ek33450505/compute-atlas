import { createHash } from "node:crypto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  SESSION_MAX_AGE_SECONDS,
  createSessionValue,
  verifySessionCookie,
} from "./admin-session";

const TOKEN = "secret-admin-token";

/**
 * Issues a v2 cookie as if `createSessionValue` had been called at
 * `issuedAtMs`, without actually sleeping — fake-time the clock for the
 * single call that reads it, then restore real time immediately so the
 * rest of the test (and `verifySessionCookie`'s own expiry check) sees the
 * real "now".
 */
function makeV2CookieAt(issuedAtMs: number, token = TOKEN): string {
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
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.API_ADMIN_TOKEN;
    } else {
      process.env.API_ADMIN_TOKEN = ORIGINAL_TOKEN;
    }
  });

  describe("v2 cookies", () => {
    it("verifies a freshly issued cookie", () => {
      const cookie = createSessionValue(TOKEN);
      expect(cookie.startsWith("v2.")).toBe(true);
      expect(verifySessionCookie(cookie)).toBe(true);
    });

    it("rejects an expired cookie (issuedAt older than the max age)", () => {
      const issuedAtMs = Date.now() - (SESSION_MAX_AGE_SECONDS * 1000 + 60_000);
      const cookie = makeV2CookieAt(issuedAtMs);
      expect(verifySessionCookie(cookie)).toBe(false);
    });

    it("accepts a cookie safely inside the max age window", () => {
      const issuedAtMs = Date.now() - (SESSION_MAX_AGE_SECONDS * 1000 - 60_000);
      const cookie = makeV2CookieAt(issuedAtMs);
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
      const cookie = makeV2CookieAt(issuedAtMs);
      expect(verifySessionCookie(cookie)).toBe(false);
    });

    it("accepts a cookie within clock-skew tolerance", () => {
      const issuedAtMs = Date.now() + 60 * 1000; // 1 minute ahead
      const cookie = makeV2CookieAt(issuedAtMs);
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
      expect(verifySessionCookie("v2.123.abc")).toBe(false);
      expect(verifySessionCookie("v2.123.abc.def.extra")).toBe(false);
    });
  });

  describe("legacy v1 cookies (TRANSITION — see #237)", () => {
    it("still verifies a valid v1 hash", () => {
      expect(verifySessionCookie(legacyHash(TOKEN))).toBe(true);
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
      const v2Cookie = createSessionValue(TOKEN);
      const v1Cookie = legacyHash(TOKEN);
      delete process.env.API_ADMIN_TOKEN;
      expect(verifySessionCookie(v2Cookie)).toBe(false);
      expect(verifySessionCookie(v1Cookie)).toBe(false);
    });
  });
});
