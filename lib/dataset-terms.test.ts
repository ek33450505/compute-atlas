import { describe, expect, it } from "vitest";

import { DATASET_TERMS_VERSION } from "@/lib/dataset-grants";
import { DATASET_COMMERCIAL_TERMS, DATASET_PRIVACY_NOTICE } from "@/lib/dataset-terms";

const commercial = DATASET_COMMERCIAL_TERMS.join("\n");
const privacy = DATASET_PRIVACY_NOTICE.join("\n");

describe("dataset terms", () => {
  it("pins the terms version", () => {
    expect(DATASET_TERMS_VERSION).toBe("2026-11-10");
  });

  it("commercial terms keep the licence whole and state the price and one-person scope", () => {
    expect(commercial).toContain("CC BY 4.0");
    expect(commercial).toContain("plus applicable tax");
    expect(commercial).toContain("one named person");
    expect(commercial).not.toContain("3 named");
    expect(commercial).not.toContain("cannot re-subscribe");
    expect(commercial).toContain("continues under the terms accepted at checkout until it is cancelled");
    expect(commercial).toContain("After a revocation, new subscriptions using the same email address or Stripe account, or the same payment card where Stripe identifies it, are refused until the revoked grant is deleted, about 365 days after revocation.");
    expect(commercial).not.toContain("For 365 days after a revocation");
    expect(commercial).toContain("$150 per month or $1,500 per year");
    expect(commercial).not.toMatch(/internal use|donation/i);
  });

  it("privacy notice names Stripe and the fingerprint hash, never the card number", () => {
    expect(privacy).toMatch(/Cloudflare and Stripe/);
    expect(privacy).toMatch(/one-way hash of the card's fingerprint \(never the card number\)/);
    expect(privacy).toMatch(/checkout session id/);
    expect(privacy).toMatch(/kept indefinitely/);
    expect(privacy).toMatch(/processed Stripe event records are deleted after 90 days/);
    expect(privacy).toMatch(/Commercial grants follow the same deletion schedule/);
    expect(privacy).toContain("ends when the revoked grant is deleted, about 365 days after revocation.");
    expect(privacy).not.toContain("ends 365 days after revocation");
  });
});
