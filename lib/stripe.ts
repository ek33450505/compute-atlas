import Stripe from "stripe";

import { DATASET_TERMS_VERSION } from "@/lib/dataset-grants";
import { siteConfig } from "@/lib/site";

export type CommercialPlan = "monthly" | "annual";

/** Missing or empty Stripe configuration. Callers map it to 503; nothing falls back. */
export class StripeConfigError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`Missing required Stripe configuration: ${variable}`);
    this.name = "StripeConfigError";
    this.variable = variable;
  }
}

/** The webhook signature header was absent, malformed, stale or did not match. */
export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeSignatureError";
  }
}

// Pinned to the default API version stripe@23.0.1 ships (ApiVersion in
// node_modules/stripe/cjs/apiVersion.js), so an SDK bump cannot silently move
// the wire format. Change it deliberately, with the SDK.
const STRIPE_API_VERSION = "2026-09-30.endive" as const;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new StripeConfigError(name);
  return value;
}

let cachedClient: Stripe | null = null;

function getClient(): Stripe {
  if (!cachedClient) {
    cachedClient = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
      apiVersion: STRIPE_API_VERSION,
    });
  }
  return cachedClient;
}

export function priceIdFor(plan: CommercialPlan): string {
  switch (plan) {
    case "monthly":
      return requireEnv("STRIPE_PRICE_COMMERCIAL_MONTHLY");
    case "annual":
      return requireEnv("STRIPE_PRICE_COMMERCIAL_ANNUAL");
    default:
      // An unvalidated string must never silently map to a plan.
      throw new Error("unknown commercial plan");
  }
}

/** Both configured commercial price ids; the webhook accepts a subscription only if its price is in here. */
export function allowedCommercialPriceIds(): Set<string> {
  return new Set([priceIdFor("monthly"), priceIdFor("annual")]);
}

export async function createCommercialCheckoutSession({
  plan,
  client,
}: {
  plan: CommercialPlan;
  client?: Stripe;
}): Promise<{ url: string; id: string }> {
  const price = priceIdFor(plan);
  const stripe = client ?? getClient();
  const metadata = {
    product: "compute_atlas_commercial_dataset",
    termsVersion: DATASET_TERMS_VERSION,
  };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    custom_fields: [
      {
        key: "organization",
        label: { type: "custom", custom: "Organization" },
        type: "text",
        optional: false,
      },
    ],
    // Stripe requires a Terms of Service URL in Dashboard > Settings > Public
    // details, or session creation fails.
    consent_collection: { terms_of_service: "required" },
    billing_address_collection: "auto",
    allow_promotion_codes: false,
    metadata,
    subscription_data: { metadata },
    success_url: `${siteConfig.url}/access/commercial/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteConfig.url}/access/commercial?canceled=1`,
  });
  if (!session.url) throw new Error("Stripe returned a Checkout session without a url");
  return { url: session.url, id: session.id };
}

export async function createBillingPortalSession({
  customerId,
  returnUrl,
  client,
}: {
  customerId: string;
  returnUrl: string;
  client?: Stripe;
}): Promise<string> {
  const stripe = client ?? getClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

/**
 * Verifies the raw request body against the Stripe-Signature header (default
 * 300 s tolerance). Fails closed: a missing header, missing secret or any
 * mismatch throws, and nothing is parsed before the signature holds.
 */
export function verifyStripeWebhook(
  rawBody: string,
  signature: string | null,
  client?: Stripe,
): Stripe.Event {
  const secret = requireEnv("STRIPE_WEBHOOK_SECRET");
  if (!signature) throw new StripeSignatureError("Missing Stripe-Signature header");
  const stripe = client ?? getClient();
  try {
    // The SDK parses the body inside constructEvent, so a validly signed but
    // unparseable body also surfaces as StripeSignatureError (both are a 400).
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    throw new StripeSignatureError(
      error instanceof Error ? error.message : "Stripe signature verification failed",
    );
  }
}

/** End of the paid period. In the 2026-09-30 API the period lives on the subscription item, not the subscription. */
export function subscriptionPeriodEnd(sub: Stripe.Subscription): Date {
  const seconds = sub.items?.data?.[0]?.current_period_end;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Stripe subscription has no item current_period_end");
  }
  return new Date(seconds * 1000);
}
