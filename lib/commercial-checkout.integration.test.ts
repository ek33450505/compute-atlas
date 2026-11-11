// @vitest-environment node
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkoutReturnBase,
  commercialCheckoutInputSchema,
  startCommercialCheckout,
  type CommercialCheckoutInput,
} from "@/lib/commercial-checkout";
import { DATASET_TERMS_VERSION } from "@/lib/dataset-grants";
import { commercialCheckoutsTable } from "@/lib/db/schema";
import { PayPalApiError } from "@/lib/paypal";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
});
beforeEach(async () => {
  await tdb.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await tdb.client.close();
});

const input: CommercialCheckoutInput = {
  plan: "monthly",
  email: "buyer@example.com",
  name: "Pat Buyer",
  organization: "Example Capital",
  acceptTerms: "on",
};

const rows = () => tdb.db.select().from(commercialCheckoutsTable);

describe("startCommercialCheckout", () => {
  const seed = (
    n: number,
    extra: Partial<typeof commercialCheckoutsTable.$inferInsert> = {},
    ageMs = 0,
    withSub = true
  ) =>
    tdb.db.insert(commercialCheckoutsTable).values(
      Array.from({ length: n }, (_, i) => ({
        plan: "monthly" as const,
        email: `other-${i}@example.com`,
        termsVersion: DATASET_TERMS_VERSION,
        createdAt: new Date(Date.now() - ageMs),
        paypalSubscriptionId: withSub ? `I-SEED-${Math.random().toString(36).slice(2)}-${i}` : null,
        ...extra,
      }))
    );
  const cap = 300; // literal on purpose: the tests must not follow the constant
  const okCreate = () => vi.fn().mockResolvedValue({ subscriptionId: "I-NEW", approveUrl: "https://www.paypal.com/x" });

  it("never refuses on identity or per-email volume", async () => {
    await seed(10, { email: input.email }, 0, false);
    const res = await startCommercialCheckout(tdb.db as never, input, { createSubscription: okCreate() });
    expect(res.ok).toBe(true);
  });

  it("refuses at the global cap with no new row, no PayPal call and a PII-free log", async () => {
    await seed(cap);
    const create = vi.fn();
    const res = await startCommercialCheckout(tdb.db as never, input, { createSubscription: create });
    expect(res).toEqual({ ok: false, reason: "busy" });
    expect(create).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(cap);
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toBe("commercial-checkout global cap reached");
  });

  it("does not count rows that never reached PayPal", async () => {
    await seed(cap, {}, 0, false);
    expect((await startCommercialCheckout(tdb.db as never, input, { createSubscription: okCreate() })).ok).toBe(true);
  });

  it("does not count activated rows", async () => {
    await seed(cap, { decision: "activate", decidedAt: new Date() });
    expect((await startCommercialCheckout(tdb.db as never, input, { createSubscription: okCreate() })).ok).toBe(true);
  });

  it("counts refused-but-not-activated rows, and ignores rows older than an hour", async () => {
    await seed(cap, {}, 2 * 60 * 60 * 1000);
    expect((await startCommercialCheckout(tdb.db as never, input, { createSubscription: okCreate() })).ok).toBe(true);
  });

  it("stores one row with the subscription id and returns the approve URL", async () => {
    const create = vi.fn().mockResolvedValue({ subscriptionId: "I-ABC123", approveUrl: "https://www.paypal.com/x" });
    const res = await startCommercialCheckout(tdb.db as never, input, { createSubscription: create });
    expect(res).toEqual({ ok: true, approveUrl: "https://www.paypal.com/x" });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      plan: "monthly",
      email: "buyer@example.com",
      name: "Pat Buyer",
      organization: "Example Capital",
      termsVersion: DATASET_TERMS_VERSION,
      paypalSubscriptionId: "I-ABC123",
      decision: null,
    });
    const arg = create.mock.calls[0][0];
    expect(arg.checkoutId).toBe(all[0].id);
    expect(arg.returnUrl).toBe(`https://www.compute-atlas.com/api/access/checkout/return?checkout=${all[0].id}`);
    expect(arg.cancelUrl).toBe("https://www.compute-atlas.com/access/commercial?cancelled=1");
  });

  it("leaves the row undecided with no subscription id when PayPal fails", async () => {
    const create = vi.fn().mockRejectedValue(new PayPalApiError(500, "INTERNAL", "dbg1"));
    const res = await startCommercialCheckout(tdb.db as never, input, { createSubscription: create });
    expect(res).toEqual({ ok: false, reason: "unavailable" });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].paypalSubscriptionId).toBeNull();
    expect(all[0].decision).toBeNull();
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("dbg1");
    expect(logged).not.toContain(input.email);
  });

  it("is unavailable, with no row and no PayPal call, when the return base is invalid", async () => {
    vi.stubEnv("COMMERCIAL_RETURN_BASE_URL", "http://evil.example");
    const create = vi.fn();
    const res = await startCommercialCheckout(tdb.db as never, input, { createSubscription: create });
    expect(res).toEqual({ ok: false, reason: "unavailable" });
    expect(create).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });
});

describe("input schema characters", () => {
  const base = { plan: "monthly", email: "a@example.com", organization: "Org", acceptTerms: "on" };
  it("accepts ordinary names, including accents", () => {
    expect(commercialCheckoutInputSchema.safeParse({ ...base, name: "José Núñez-O'Brien" }).success).toBe(true);
  });
  it.each([
    ["markup", "<b>x"],
    ["C0 control", "a\u0007b"],
    ["C1 control", "a\u0085b"],
    ["zero-width", "a\u200bb"],
    ["bidi override", "a\u202eb"],
    ["bidi isolate", "a\u2066b"],
    ["BOM", "a\ufeffb"],
    ["line separator U+2028", "a\u2028b"],
    ["paragraph separator U+2029", "a\u2029b"],
    ["soft hyphen U+00AD", "a\u00adb"],
    ["tag character U+E0041", "a\u{E0041}b"],
    ["fullwidth less-than U+FF1C", "a\uff1cb"],
    ["fullwidth greater-than U+FF1E", "a\uff1eb"],
    ["small less-than U+FE64", "a\ufe64b"],
    ["private use U+E000", "a\ue000b"],
    ["unpaired surrogate", "a\ud800b"],
  ])("rejects %s in name and organization", (_l, value) => {
    expect(commercialCheckoutInputSchema.safeParse({ ...base, name: value }).success).toBe(false);
    expect(commercialCheckoutInputSchema.safeParse({ ...base, name: "ok", organization: value }).success).toBe(false);
  });
});

describe("checkoutReturnBase", () => {
  it("in production only accepts the site's own host", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("COMMERCIAL_RETURN_BASE_URL", "https://preview-abc.vercel.app");
    expect(() => checkoutReturnBase()).toThrow();
    vi.stubEnv("COMMERCIAL_RETURN_BASE_URL", "https://www.compute-atlas.com");
    expect(checkoutReturnBase()).toBe("https://www.compute-atlas.com");
  });
  it("outside production accepts a preview host", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("COMMERCIAL_RETURN_BASE_URL", "https://preview-abc.vercel.app");
    expect(checkoutReturnBase()).toBe("https://preview-abc.vercel.app");
  });
  it("defaults to the site URL", () => {
    expect(checkoutReturnBase()).toBe("https://www.compute-atlas.com");
  });
  it.each([
    ["https://preview-abc.vercel.app/", "https://preview-abc.vercel.app"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
  ])("accepts %s", (raw, expected) => {
    vi.stubEnv("COMMERCIAL_RETURN_BASE_URL", raw);
    expect(checkoutReturnBase()).toBe(expected);
  });
  it.each(["http://example.com", "javascript:alert(1)", "not a url", "ftp://x.test"])("rejects %s", (raw) => {
    vi.stubEnv("COMMERCIAL_RETURN_BASE_URL", raw);
    expect(() => checkoutReturnBase()).toThrow();
  });
});
