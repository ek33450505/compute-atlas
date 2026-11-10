import { afterEach, describe, it, expect, vi } from "vitest";
import { siteConfig } from "@/lib/site";

describe("siteConfig.metaDescription", () => {
  it("stays within the SERP-safe length budget", () => {
    // Google renders ~155 chars on desktop, ~120 on mobile — this must be
    // short enough that the terms people search land before the cut.
    expect(siteConfig.metaDescription.length).toBeLessThanOrEqual(160);
  });

  it("is distinct from the long JSON-LD description", () => {
    // Guards against "tidying" the two back into one string — description
    // is deliberately long (it feeds Dataset/WebSite JSON-LD, where length
    // is an asset), metaDescription is deliberately short.
    expect(siteConfig.metaDescription).not.toBe(siteConfig.description);
  });

  it("description stays long enough to remain useful for Dataset JSON-LD", () => {
    // description must stay well over the meta-description budget — if it
    // ever shrinks to fit that budget, the split has silently been undone.
    expect(siteConfig.description.length).toBeGreaterThan(160);
  });
});

describe("siteConfig.supportLinks", () => {
  it("has the four slots, each null or a Stripe Payment Link", () => {
    expect(Object.keys(siteConfig.supportLinks).sort()).toEqual([
      "monthly15",
      "monthly5",
      "monthly50",
      "oneOff",
    ]);
    for (const v of Object.values(siteConfig.supportLinks)) {
      expect(v === null || v.startsWith("https://buy.stripe.com/")).toBe(true);
    }
  });

  it("has no legacy third-party funding entry", () => {
    expect(Object.keys(siteConfig)).not.toContain("ko" + "fiUrl");
  });
});

describe("siteConfig.supportLinks from env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads valid Stripe links and ignores everything else", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_STRIPE_SUPPORT_MONTHLY_5", "https://buy.stripe.com/five");
    vi.stubEnv("NEXT_PUBLIC_STRIPE_SUPPORT_MONTHLY_15", "https://example.com/fifteen");
    vi.stubEnv("NEXT_PUBLIC_STRIPE_SUPPORT_ONE_OFF", "https://buy.stripe.com/tip");
    const { siteConfig: fresh } = await import("@/lib/site");
    expect(fresh.supportLinks).toEqual({
      monthly5: "https://buy.stripe.com/five",
      monthly15: null,
      monthly50: null,
      oneOff: "https://buy.stripe.com/tip",
    });
  });
});
