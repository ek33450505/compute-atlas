import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  rateLimitDecision,
  RATE_LIMIT_MAX,
  extractTrustedClientIp,
  normaliseIpForBucketing,
  hashIp,
} from "@/lib/rate-limit";

describe("rateLimitDecision", () => {
  it("allows when count is below the max", () => {
    expect(rateLimitDecision(0).ok).toBe(true);
    expect(rateLimitDecision(RATE_LIMIT_MAX - 1).ok).toBe(true);
  });

  it("blocks when count reaches the max", () => {
    expect(rateLimitDecision(RATE_LIMIT_MAX).ok).toBe(false);
    expect(rateLimitDecision(RATE_LIMIT_MAX + 1).ok).toBe(false);
  });
});

describe("extractTrustedClientIp", () => {
  it("prefers x-real-ip over x-forwarded-for when both are present", () => {
    const headers = new Headers({
      "x-real-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.1, 203.0.113.9",
    });
    expect(extractTrustedClientIp(headers)).toBe("203.0.113.9");
  });

  it("falls back to the rightmost x-forwarded-for entry when x-real-ip is absent", () => {
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.1, 198.51.100.2, 203.0.113.9",
    });
    expect(extractTrustedClientIp(headers)).toBe("203.0.113.9");
  });

  // This is the whole point of `extractTrustedClientIp`: unlike the naive
  // leftmost-x-forwarded-for extraction this module once had, a spoofed
  // LEFTMOST x-forwarded-for entry (the attacker-controllable one) must not
  // change the derived IP — only the rightmost entry, appended by the
  // trusted proxy, is trusted.
  it("ignores a spoofed leftmost x-forwarded-for entry", () => {
    const trusted = "203.0.113.9";
    const spoofedOnce = new Headers({
      "x-forwarded-for": `1.2.3.4, ${trusted}`,
    });
    const spoofedAgain = new Headers({
      "x-forwarded-for": `9.9.9.9, ${trusted}`,
    });
    expect(extractTrustedClientIp(spoofedOnce)).toBe(trusted);
    expect(extractTrustedClientIp(spoofedAgain)).toBe(trusted);
    expect(extractTrustedClientIp(spoofedOnce)).toBe(extractTrustedClientIp(spoofedAgain));
  });

  it("falls through to \"unknown\" when headers are empty or whitespace", () => {
    expect(extractTrustedClientIp(new Headers())).toBe("unknown");
    expect(
      extractTrustedClientIp(new Headers({ "x-real-ip": "   ", "x-forwarded-for": "   " }))
    ).toBe("unknown");
  });

  // Production check (2026-09-03): 21 requests from one stable IPv4 egress
  // produced 20 distinct ip_hash buckets, because the leftmost XFF entry
  // rotates per request on the Cloudflare -> Vercel path. cf-connecting-ip is
  // set by Cloudflare itself (overwritten, not passed through), so it must
  // win over a spoofed/rotating leftmost XFF entry regardless of what the
  // rest of the chain says.
  it("prefers cf-connecting-ip over a spoofed leftmost x-forwarded-for entry", () => {
    const trusted = "203.0.113.9";
    const headers = new Headers({
      "cf-connecting-ip": trusted,
      "x-forwarded-for": "1.2.3.4, 198.51.100.1",
    });
    expect(extractTrustedClientIp(headers)).toBe(trusted);
  });

  it("prefers cf-connecting-ip over x-real-ip when both are present", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "x-real-ip": "198.51.100.1",
    });
    expect(extractTrustedClientIp(headers)).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip when cf-connecting-ip is absent", () => {
    const headers = new Headers({
      "x-real-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.1, 203.0.113.9",
    });
    expect(extractTrustedClientIp(headers)).toBe("203.0.113.9");
  });

  // The individual precedence tests above only ever pit cf-connecting-ip
  // against ONE lower-priority header at a time. This covers all three
  // headers present simultaneously, so a regression that only checks
  // cf-connecting-ip against x-real-ip (or against x-forwarded-for) in
  // isolation, but falls through incorrectly when all three are set, would
  // still be caught.
  it("prefers cf-connecting-ip when cf-connecting-ip, x-real-ip, and x-forwarded-for are all present", () => {
    const trusted = "203.0.113.9";
    const headers = new Headers({
      "cf-connecting-ip": trusted,
      "x-real-ip": "198.51.100.1",
      "x-forwarded-for": "1.2.3.4, 198.51.100.2",
    });
    expect(extractTrustedClientIp(headers)).toBe(trusted);
  });
});

describe("normaliseIpForBucketing", () => {
  it("leaves IPv4 addresses unchanged", () => {
    expect(normaliseIpForBucketing("203.0.113.9")).toBe("203.0.113.9");
  });

  it("leaves the \"unknown\" sentinel unchanged", () => {
    expect(normaliseIpForBucketing("unknown")).toBe("unknown");
  });

  it("treats an IPv4-mapped IPv6 address as plain IPv4", () => {
    expect(normaliseIpForBucketing("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  // The failure mode this exists to close: a residential IPv6 client is
  // delegated a whole /64 and rotates its source address within it
  // (RFC 4941 privacy extensions), so two addresses differing only in the
  // interface identifier (the last 4 groups) are the SAME client and must
  // collapse to the same bucket key.
  it("collapses two IPv6 addresses in the same /64 to one bucket", () => {
    const a = normaliseIpForBucketing("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
    const b = normaliseIpForBucketing("2001:db8:1234:5678:1111:2222:3333:4444");
    expect(a).toBe(b);
    expect(a).toBe("2001:db8:1234:5678");
  });

  it("keeps two different /64s as separate buckets", () => {
    const a = normaliseIpForBucketing("2001:db8:1234:5678::1");
    const b = normaliseIpForBucketing("2001:db8:1234:9999::1");
    expect(a).not.toBe(b);
  });

  it("handles :: zero-compression before the fourth group by prefix length, not string length", () => {
    // "2001:db8::1" has only 3 explicit groups, but its /64 prefix is
    // "2001:db8:0:0" — the compressed run pads out to the fourth group.
    expect(normaliseIpForBucketing("2001:db8::1")).toBe("2001:db8:0:0");
  });

  // A leading "::" means the head is EMPTY and the tail carries every
  // explicit group — a naive implementation that only ever reads the
  // pre-"::" head gets this wrong, because there's no head to read. Worked
  // example from the review: "::2001:db8:1:2:3:4:5" expands to
  // "0:2001:db8:1:2:3:4:5" (1 padding zero + 7 tail groups = 8), so the
  // correct /64 is "0:2001:db8:1", not "0:0:0:0".
  it("expands a leading :: using the tail groups, not a blank head", () => {
    expect(normaliseIpForBucketing("::2001:db8:1:2:3:4:5")).toBe("0:2001:db8:1");
  });

  // A second leading-"::" shape with a shorter tail (6 groups, 2 padding
  // zeros), so the prefix is made up of padding AND tail groups together —
  // distinct from the 7-group tail (1 padding zero) worked example above.
  it("expands a leading :: with a different tail length", () => {
    expect(normaliseIpForBucketing("::1:2:3:4:5:6")).toBe("0:0:1:2");
  });

  it("keeps :: (loopback) correct after the leading-:: rewrite", () => {
    // "::1" expands to 7 zero groups + "1"; its /64 prefix is still
    // "0:0:0:0" as before the fix — this must not regress.
    expect(normaliseIpForBucketing("::1")).toBe("0:0:0:0");
  });
});

describe("hashIp", () => {
  const ORIGINAL_SALT = process.env.CONTRIBUTE_IP_SALT;
  const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;

  beforeEach(() => {
    delete process.env.CONTRIBUTE_IP_SALT;
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    if (ORIGINAL_SALT === undefined) {
      delete process.env.CONTRIBUTE_IP_SALT;
    } else {
      process.env.CONTRIBUTE_IP_SALT = ORIGINAL_SALT;
    }
    if (ORIGINAL_VERCEL_ENV === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV;
    }
  });

  it("throws in production when CONTRIBUTE_IP_SALT is unset", () => {
    process.env.VERCEL_ENV = "production";
    expect(() => hashIp("203.0.113.9")).toThrow(
      /CONTRIBUTE_IP_SALT must be set in production/
    );
  });

  it("falls back to the built-in salt and returns a sha256 hex digest when unset outside production", () => {
    const hash = hashIp("203.0.113.9");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different digest than the fallback once a real salt is set", () => {
    const fallbackHash = hashIp("203.0.113.9");
    process.env.CONTRIBUTE_IP_SALT = "a-real-random-salt";
    const saltedHash = hashIp("203.0.113.9");
    expect(saltedHash).not.toBe(fallbackHash);
    expect(saltedHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
