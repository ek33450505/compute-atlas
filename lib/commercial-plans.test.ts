import { describe, expect, it } from "vitest";

import { COMMERCIAL_PATH, COMMERCIAL_PLANS, formatPlanPrice } from "./commercial-plans";

describe("commercial plans", () => {
  it("formats both prices", () => {
    expect(formatPlanPrice("monthly")).toBe("$150/month");
    expect(formatPlanPrice("annual")).toBe("$1,500/year");
  });
  it("keeps the annual plan at ten months", () => {
    expect(COMMERCIAL_PLANS.annual.priceUsd).toBe(COMMERCIAL_PLANS.monthly.priceUsd * 10);
  });
  it("points at the paid page", () => {
    expect(COMMERCIAL_PATH).toBe("/access/commercial");
  });
});
