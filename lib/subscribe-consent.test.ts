// @vitest-environment node
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_SECONDS,
  createConsentValue,
  readConsentCookie,
  verifyConsentCookie,
} from "@/lib/subscribe-consent";

const TEST_SALT = "consent-test-salt-v1";
const EMAIL = "reader@example.com";

// Saved/restored by hand rather than via vi.unstubAllEnvs: `unstubEnvs` is not
// enabled in vitest.config.ts, so a stub would otherwise leak into every later
// file in this worker — and the whole point of several cases below is that an
// UNSET salt changes behaviour.
const ORIGINAL_SALT = process.env.CONTRIBUTE_IP_SALT;

beforeEach(() => {
  process.env.CONTRIBUTE_IP_SALT = TEST_SALT;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (ORIGINAL_SALT === undefined) {
    delete process.env.CONTRIBUTE_IP_SALT;
  } else {
    process.env.CONTRIBUTE_IP_SALT = ORIGINAL_SALT;
  }
});

/** Replaces one part of a `v1.<issuedAt>.<nonce>.<tag>.<hmac>` value. */
function withPart(value: string, index: number, replacement: string): string {
  const parts = value.split(".");
  parts[index] = replacement;
  return parts.join(".");
}

describe("createConsentValue / verifyConsentCookie round trip", () => {
  it("verifies a freshly minted value for the same address", () => {
    const value = createConsentValue(EMAIL);
    expect(value).toBeDefined();
    expect(verifyConsentCookie(value, EMAIL)).toBe(true);
  });

  it("emits the documented 5-part shape with a fixed charset per field", () => {
    const parts = (createConsentValue(EMAIL) ?? "").split(".");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toMatch(/^\d+$/);
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(parts[4]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never emits the same value twice (per-issue nonce)", () => {
    expect(createConsentValue(EMAIL)).not.toBe(createConsentValue(EMAIL));
  });

  it("normalizes the address the same way subscribeToTarget does, both directions", () => {
    const value = createConsentValue("  Reader@Example.COM ");
    expect(verifyConsentCookie(value, EMAIL)).toBe(true);
    expect(verifyConsentCookie(createConsentValue(EMAIL), " READER@example.com  ")).toBe(true);
  });

  // THE binding. Without it the cookie proves only "this browser confirmed
  // SOME address", which an attacker gets for free by confirming a throwaway
  // address and can then spend on any victim.
  it("does NOT verify for a different address", () => {
    const value = createConsentValue(EMAIL);
    expect(verifyConsentCookie(value, "victim@example.com")).toBe(false);
  });
});

describe("verifyConsentCookie — rejects anything it did not issue", () => {
  it.each([
    ["undefined", undefined],
    ["empty string", ""],
    ["unknown version prefix", "v2.1.2.3.4"],
    ["too few parts", "v1.1.2.3"],
    ["too many parts", "v1.1.2.3.4.5"],
  ])("rejects %s", (_label, value) => {
    expect(verifyConsentCookie(value as string | undefined, EMAIL)).toBe(false);
  });

  it("rejects a tampered HMAC", () => {
    const value = createConsentValue(EMAIL) ?? "";
    const hmac = value.split(".")[4];
    const flipped = (hmac[0] === "a" ? "b" : "a") + hmac.slice(1);
    expect(verifyConsentCookie(withPart(value, 4, flipped), EMAIL)).toBe(false);
  });

  it("rejects an email tag re-pointed at another address (the tag is inside the signed input)", () => {
    const mine = createConsentValue(EMAIL) ?? "";
    const theirs = createConsentValue("victim@example.com") ?? "";
    const swapped = withPart(mine, 3, theirs.split(".")[3]);
    expect(verifyConsentCookie(swapped, "victim@example.com")).toBe(false);
  });

  it("rejects an edited issuedAt (the timestamp is inside the signed input)", () => {
    const value = createConsentValue(EMAIL) ?? "";
    // Offset by a full second, not `Date.now()`: minting and editing land in
    // the same millisecond often enough that the "edit" would be a no-op and
    // the test would pass without proving anything.
    const edited = String(Number(value.split(".")[1]) - 1000);
    expect(verifyConsentCookie(withPart(value, 1, edited), EMAIL)).toBe(false);
  });

  it.each([
    ["a non-hex nonce", 2, "z".repeat(32)],
    ["a short nonce", 2, "ab"],
    ["a non-hex tag", 3, "z".repeat(64)],
    ["a non-hex hmac", 4, "z".repeat(64)],
    ["a signed issuedAt", 1, "-1"],
    ["a decimal issuedAt", 1, "1.5"],
    ["an issuedAt past MAX_SAFE_INTEGER", 1, "9".repeat(30)],
  ])("rejects %s", (_label, index, replacement) => {
    const value = createConsentValue(EMAIL) ?? "";
    expect(verifyConsentCookie(withPart(value, index, replacement), EMAIL)).toBe(false);
  });
});

describe("verifyConsentCookie — server-side lifetime", () => {
  it("is exactly 30 minutes, pinned independently of the constant's own value", () => {
    // Deliberately NOT derived from CONSENT_MAX_AGE_SECONDS — a test that
    // computes its expectation from the constant it is checking cannot fail
    // when that constant is fat-fingered.
    expect(CONSENT_MAX_AGE_SECONDS).toBe(1800);
  });

  it("rejects a value older than the lifetime, and accepts one just inside it", () => {
    const issuedAt = new Date("2026-09-27T12:00:00Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(issuedAt);
    const value = createConsentValue(EMAIL);

    vi.setSystemTime(issuedAt + CONSENT_MAX_AGE_SECONDS * 1000 - 1000);
    expect(verifyConsentCookie(value, EMAIL)).toBe(true);

    vi.setSystemTime(issuedAt + CONSENT_MAX_AGE_SECONDS * 1000 + 1000);
    expect(verifyConsentCookie(value, EMAIL)).toBe(false);
  });

  it("tolerates small clock skew but rejects a value future-dated beyond it", () => {
    const now = new Date("2026-09-27T12:00:00Z").getTime();
    vi.useFakeTimers();

    vi.setSystemTime(now + 60_000); // issued 1 minute "ahead" of the verifier
    const skewed = createConsentValue(EMAIL);
    vi.setSystemTime(now);
    expect(verifyConsentCookie(skewed, EMAIL)).toBe(true);

    vi.setSystemTime(now + 10 * 60_000); // 10 minutes ahead — beyond tolerance
    const tooFar = createConsentValue(EMAIL);
    vi.setSystemTime(now);
    expect(verifyConsentCookie(tooFar, EMAIL)).toBe(false);
  });
});

describe("signing key", () => {
  it("mints nothing and verifies nothing when CONTRIBUTE_IP_SALT is unset (fails closed)", () => {
    const value = createConsentValue(EMAIL);
    expect(value).toBeDefined();

    delete process.env.CONTRIBUTE_IP_SALT;
    expect(createConsentValue(EMAIL)).toBeUndefined();
    expect(verifyConsentCookie(value, EMAIL)).toBe(false);
  });

  it("does not accept a value minted under a different salt", () => {
    const value = createConsentValue(EMAIL);
    process.env.CONTRIBUTE_IP_SALT = "a-different-salt";
    expect(verifyConsentCookie(value, EMAIL)).toBe(false);
  });

  // Domain separation: the signing key is HMAC(salt, "subscribe-consent-v1"),
  // NOT the salt. Forging with the raw salt must fail, or the salt's other use
  // (the stored submitter_ip_hash digests) and this cookie would share a key.
  it("is domain-separated from the raw salt — a value signed with the salt itself is rejected", () => {
    const issuedAt = Date.now();
    const nonce = "a".repeat(32);
    const tag = createHmac("sha256", TEST_SALT).update(`email:${EMAIL}`).digest("hex");
    const hmac = createHmac("sha256", TEST_SALT)
      .update(`v1.${issuedAt}.${nonce}.${tag}`)
      .digest("hex");
    expect(verifyConsentCookie(`v1.${issuedAt}.${nonce}.${tag}.${hmac}`, EMAIL)).toBe(false);
  });
});

describe("readConsentCookie", () => {
  it("returns undefined with no Cookie header", () => {
    expect(readConsentCookie(new Headers())).toBeUndefined();
  });

  it("returns undefined when the consent cookie is absent", () => {
    const headers = new Headers({ cookie: "admin_session=v2.1.2.3; other=x" });
    expect(readConsentCookie(headers)).toBeUndefined();
  });

  it("finds the value among other cookies, whitespace and all", () => {
    const value = createConsentValue(EMAIL) ?? "";
    const headers = new Headers({
      cookie: `admin_session=nope;  ${CONSENT_COOKIE_NAME}=${value} ; trailing=1`,
    });
    expect(readConsentCookie(headers)).toBe(value);
    expect(verifyConsentCookie(readConsentCookie(headers), EMAIL)).toBe(true);
  });

  it("treats an empty value as absent", () => {
    const headers = new Headers({ cookie: `${CONSENT_COOKIE_NAME}=` });
    expect(readConsentCookie(headers)).toBeUndefined();
  });

  it("does not match a cookie whose name merely ends with the consent name", () => {
    const headers = new Headers({ cookie: `not_${CONSENT_COOKIE_NAME}=v1.1.2.3.4` });
    expect(readConsentCookie(headers)).toBeUndefined();
  });

  it("returns the first occurrence when the name is repeated", () => {
    const headers = new Headers({
      cookie: `${CONSENT_COOKIE_NAME}=first; ${CONSENT_COOKIE_NAME}=second`,
    });
    expect(readConsentCookie(headers)).toBe("first");
  });
});
