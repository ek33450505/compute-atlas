import { afterEach, describe, expect, it, vi } from "vitest";

import { isCommercialTierEnabled } from "@/lib/commercial-flag";

describe("isCommercialTierEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is on only for the exact string true", () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    expect(isCommercialTierEnabled()).toBe(true);
  });

  it.each(["", "TRUE", "True", "1", "yes", " true", "false"])("is dark for %j", (value) => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", value);
    expect(isCommercialTierEnabled()).toBe(false);
  });

  it("is dark when unset", () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", undefined);
    expect(isCommercialTierEnabled()).toBe(false);
  });
});
