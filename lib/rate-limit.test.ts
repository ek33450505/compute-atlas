import { describe, it, expect } from "vitest";

import { rateLimitDecision, RATE_LIMIT_MAX } from "@/lib/rate-limit";

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
