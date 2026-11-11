import { describe, expect, it } from "vitest";

import { DATASET_TERMS_VERSION } from "@/lib/dataset-grants";
import { DATASET_COMMERCIAL_TERMS, DATASET_PRIVACY_NOTICE } from "@/lib/dataset-terms";

const commercial = DATASET_COMMERCIAL_TERMS.join("\n");
const privacy = DATASET_PRIVACY_NOTICE.join("\n");

describe("dataset terms", () => {
  it("pins the terms version", () => {
    expect(DATASET_TERMS_VERSION).toBe("2026-11-11");
  });

  it("commercial terms keep the licence whole and state the price, PayPal and one-person scope", () => {
    expect(commercial).toContain("CC BY 4.0");
    expect(commercial).toContain("$150 per month or $1,500 per year, plus applicable tax, paid through PayPal. A PayPal account is required.");
    expect(commercial).toContain("one named person");
    expect(commercial).toContain("continues under the terms accepted at checkout until it is cancelled");
    expect(commercial).toContain("in your PayPal account's automatic payments settings");
    expect(commercial).toContain("There are no refunds for partial periods, except where the law requires one. The maintainer may refund at their discretion.");
    expect(commercial).toContain("Revoking cancels that subscription and ends access. You may subscribe again later.");
    expect(commercial).not.toMatch(/stripe|fingerprint|billing portal|manage billing/i);
    expect(commercial).not.toMatch(/refused|automatically/i);
    expect(commercial).not.toMatch(/internal use|donation/i);
  });

  it("privacy notice names PayPal, states the checkout and event retention, and never mentions Stripe", () => {
    expect(privacy).toMatch(/Cloudflare and PayPal/);
    expect(privacy).not.toMatch(/stripe|fingerprint/i);
    expect(privacy).toContain("Checkout records that never reach a decision are deleted after 30 days.");
    expect(privacy).toContain("the name, email and organization are removed after 365 days");
    expect(privacy).toContain("the PayPal subscription id, the paid-through date and the time of the last payment");
    expect(privacy).toContain("processed PayPal event records are deleted after 90 days");
    expect(privacy).toContain("that backup is deleted after 30 days");
    expect(privacy).toContain("PayPal holds payment details under its own privacy policy");
  });
});
