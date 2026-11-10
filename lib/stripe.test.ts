import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATASET_TERMS_VERSION } from "@/lib/dataset-grants";
import {
  allowedCommercialPriceIds,
  type CommercialPlan,
  createBillingPortalSession,
  createCommercialCheckoutSession,
  priceIdFor,
  StripeConfigError,
  StripeSignatureError,
  subscriptionPeriodEnd,
  verifyStripeWebhook,
} from "@/lib/stripe";

const WEBHOOK_SECRET = "whsec_test_secret";

// Constructing a client makes no network call; only the offline webhook helpers are used on it.
const offlineClient = new Stripe("sk_test_offline_dummy");

function setEnv() {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("STRIPE_PRICE_COMMERCIAL_MONTHLY", "price_monthly_x");
  vi.stubEnv("STRIPE_PRICE_COMMERCIAL_ANNUAL", "price_annual_x");
}

function fakeClient(create: ReturnType<typeof vi.fn>, portalCreate = vi.fn()): Stripe {
  return {
    checkout: { sessions: { create } },
    billingPortal: { sessions: { create: portalCreate } },
  } as unknown as Stripe;
}

beforeEach(setEnv);
afterEach(() => vi.unstubAllEnvs());

describe("config", () => {
  it.each([
    ["STRIPE_PRICE_COMMERCIAL_MONTHLY", () => priceIdFor("monthly")],
    ["STRIPE_PRICE_COMMERCIAL_ANNUAL", () => priceIdFor("annual")],
    ["STRIPE_PRICE_COMMERCIAL_ANNUAL", () => allowedCommercialPriceIds()],
    ["STRIPE_WEBHOOK_SECRET", () => verifyStripeWebhook("{}", "t=1,v1=x", offlineClient)],
  ])("throws StripeConfigError naming %s when unset", (name, call) => {
    vi.stubEnv(name, undefined);
    try {
      call();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StripeConfigError);
      expect((error as StripeConfigError).variable).toBe(name);
      expect((error as Error).message).toContain(name);
    }
  });

  it("treats an empty or whitespace value as missing", () => {
    vi.stubEnv("STRIPE_PRICE_COMMERCIAL_MONTHLY", "   ");
    expect(() => priceIdFor("monthly")).toThrow(StripeConfigError);
  });

  it.each(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"])("treats whitespace-only %s as missing", async (name) => {
    vi.stubEnv(name, "   ");
    const call =
      name === "STRIPE_SECRET_KEY"
        ? createCommercialCheckoutSession({ plan: "monthly" })
        : Promise.resolve().then(() => verifyStripeWebhook("{}", "t=1,v1=x", offlineClient));
    await expect(call).rejects.toMatchObject({ variable: name });
  });

  it("throws on an unknown plan instead of defaulting", () => {
    expect(() => priceIdFor("weekly" as CommercialPlan)).toThrow("unknown commercial plan");
  });

  it("throws for a missing secret key when it has to build its own client", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", undefined);
    await expect(createCommercialCheckoutSession({ plan: "monthly" })).rejects.toMatchObject({
      variable: "STRIPE_SECRET_KEY",
    });
  });

  it("maps plans to prices and lists both allowed ids", () => {
    expect(priceIdFor("monthly")).toBe("price_monthly_x");
    expect(priceIdFor("annual")).toBe("price_annual_x");
    expect(allowedCommercialPriceIds()).toEqual(new Set(["price_monthly_x", "price_annual_x"]));
  });
});

describe("createCommercialCheckoutSession", () => {
  it.each([
    ["monthly", "price_monthly_x"],
    ["annual", "price_annual_x"],
  ] as const)("builds the %s subscription session", async (plan, price) => {
    const create = vi.fn().mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.test/c/1" });
    const result = await createCommercialCheckoutSession({ plan, client: fakeClient(create) });

    expect(result).toEqual({ id: "cs_test_1", url: "https://checkout.stripe.test/c/1" });
    const params = create.mock.calls[0][0];
    const metadata = { product: "compute_atlas_commercial_dataset", termsVersion: DATASET_TERMS_VERSION };
    expect(params.mode).toBe("subscription");
    expect(params.allowed_payment_method_types).toEqual(["card"]);
    expect(params).not.toHaveProperty("customer");
    expect(params.line_items).toEqual([{ price, quantity: 1 }]);
    expect(params.custom_fields).toEqual([
      { key: "organization", label: { type: "custom", custom: "Organization" }, type: "text", optional: false },
    ]);
    expect(params.consent_collection).toEqual({ terms_of_service: "required" });
    expect(params.billing_address_collection).toBe("auto");
    expect(params.allow_promotion_codes).toBe(false);
    expect(params.metadata).toEqual(metadata);
    expect(params.subscription_data).toEqual({ metadata });
    expect(params.success_url).toBe(
      "https://www.compute-atlas.com/access/commercial/success?session_id={CHECKOUT_SESSION_ID}",
    );
    expect(params.cancel_url).toBe("https://www.compute-atlas.com/access/commercial?canceled=1");
  });

  it("throws when Stripe returns no url", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_test_2", url: null });
    await expect(createCommercialCheckoutSession({ plan: "monthly", client: fakeClient(create) })).rejects.toThrow(
      /without a url/,
    );
  });
});

describe("createBillingPortalSession", () => {
  it("returns the portal url", async () => {
    const portalCreate = vi.fn().mockResolvedValue({ url: "https://portal.stripe.test/p/1" });
    const url = await createBillingPortalSession({
      customerId: "cus_1",
      returnUrl: "https://www.compute-atlas.com/access/dataset",
      client: fakeClient(vi.fn(), portalCreate),
    });
    expect(url).toBe("https://portal.stripe.test/p/1");
    expect(portalCreate).toHaveBeenCalledWith({
      customer: "cus_1",
      return_url: "https://www.compute-atlas.com/access/dataset",
    });
  });
});

describe("verifyStripeWebhook", () => {
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed" });
  const sign = (body: string, secret = WEBHOOK_SECRET, timestamp?: number) =>
    offlineClient.webhooks.generateTestHeaderString({ payload: body, secret, timestamp });

  it("accepts a correctly signed payload", () => {
    const event = verifyStripeWebhook(payload, sign(payload), offlineClient);
    expect(event.id).toBe("evt_1");
    expect(event.type).toBe("checkout.session.completed");
  });

  it("rejects a tampered body", () => {
    const header = sign(payload);
    expect(() => verifyStripeWebhook(payload.replace("evt_1", "evt_2"), header, offlineClient)).toThrow(
      StripeSignatureError,
    );
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(() => verifyStripeWebhook(payload, sign(payload, "whsec_other"), offlineClient)).toThrow(
      StripeSignatureError,
    );
  });

  it.each([null, ""])("rejects a missing header (%j)", (header) => {
    expect(() => verifyStripeWebhook(payload, header, offlineClient)).toThrow(StripeSignatureError);
  });

  it("rejects an expired timestamp", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(() => verifyStripeWebhook(payload, sign(payload, WEBHOOK_SECRET, old), offlineClient)).toThrow(
      StripeSignatureError,
    );
  });
});

describe("subscriptionPeriodEnd", () => {
  const sub = (items: unknown) => ({ items: { data: items } }) as unknown as Stripe.Subscription;

  it("reads the first item's current_period_end", () => {
    expect(subscriptionPeriodEnd(sub([{ current_period_end: 1_800_000_000 }])).toISOString()).toBe(
      new Date(1_800_000_000_000).toISOString(),
    );
  });

  it.each([[[]], [[{}]], [[{ current_period_end: Number.NaN }]], [undefined]])(
    "throws rather than return an invalid date for %j",
    (items) => {
      expect(() => subscriptionPeriodEnd(sub(items))).toThrow(/current_period_end/);
    },
  );
});
