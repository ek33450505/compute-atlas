import { describe, it, expect } from "vitest";

import { rateLimitDecision, RATE_LIMIT_MAX, extractTrustedClientIp } from "@/lib/rate-limit";

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

  // This is the whole point of `extractTrustedClientIp`: unlike
  // `extractClientIp`, a spoofed LEFTMOST x-forwarded-for entry (the
  // attacker-controllable one) must not change the derived IP — only the
  // rightmost entry, appended by the trusted proxy, is trusted.
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
});
