import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { DATASET_TERMS_VERSION } from "@/lib/dataset-grants";
import { redactedErrorCode } from "@/lib/db-error";
import { commercialCheckoutsTable } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/email-address";
import { storableText } from "@/lib/intake-fields";
import { createSubscription, PayPalApiError, PayPalConfigError, type CommercialPlan } from "@/lib/paypal";
import { siteConfig } from "@/lib/site";

/** Either the Neon HTTP client or PGlite in tests; nothing here uses a transaction. */
export type CommercialDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Backstop on PayPal subscription creation: checkouts in any rolling hour that reached PayPal and are not yet
 * activated. Failed PayPal attempts and paying customers never count; the per-IP limit is the real control.
 */
export const COMMERCIAL_CHECKOUT_GLOBAL_HOURLY_CAP = 300;

const HOUR_MS = 60 * 60 * 1000;

// Markup (ASCII and fullwidth angle brackets) and every "other" or line/paragraph-separator character never belong in
// a buyer's name or organization: both end up in mail and the admin view. \p{C} covers controls (C0/C1), format
// characters (zero-width, bidi, soft hyphen, BOM, the tag block), unassigned, private use and surrogates.
// NFKC folds the other angle-bracket look-alikes (small, CJK) onto `<`/`>`, so the check runs on the folded form too.
const FORBIDDEN_CHARS = /[<>\uff1c\uff1e\p{C}\p{Zl}\p{Zp}]/u;
const hasForbiddenChars = (v: string) => FORBIDDEN_CHARS.test(v) || FORBIDDEN_CHARS.test(v.normalize("NFKC"));
const plainText = () =>
  storableText(z.string().trim().min(1).max(200)).refine((v) => !hasForbiddenChars(v), {
    message: "Remove unsupported characters.",
  });

export const commercialCheckoutInputSchema = z.object({
  plan: z.enum(["monthly", "annual"]),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((v) => normalizeEmail(v)),
  name: plainText(),
  organization: plainText(),
  // A native checkbox posts "on" when ticked and nothing otherwise.
  acceptTerms: z.literal("on"),
});

export type CommercialCheckoutInput = z.infer<typeof commercialCheckoutInputSchema>;

/**
 * Origin PayPal sends the buyer back to. `COMMERCIAL_RETURN_BASE_URL` (previews) or the site URL; never the
 * request or Host header, which a client controls. Throws on anything but https (or http on loopback).
 */
export function checkoutReturnBase(): string {
  const raw = process.env.COMMERCIAL_RETURN_BASE_URL?.trim();
  if (!raw) return siteConfig.url.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PayPalConfigError("COMMERCIAL_RETURN_BASE_URL");
  }
  const loopback = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !loopback) throw new PayPalConfigError("COMMERCIAL_RETURN_BASE_URL");
  // Production only ever returns to the real site; an override is for previews.
  if (process.env.VERCEL_ENV === "production" && url.host !== new URL(siteConfig.url).host) {
    throw new PayPalConfigError("COMMERCIAL_RETURN_BASE_URL");
  }
  return url.origin;
}

export type StartCheckoutResult =
  | { ok: true; approveUrl: string }
  | { ok: false; reason: "busy" | "unavailable" };

export type StartCheckoutDeps = { createSubscription: typeof createSubscription };

const defaultDeps: StartCheckoutDeps = { createSubscription };

function logFailure(err: unknown): void {
  if (err instanceof PayPalApiError) {
    console.error(
      `commercial-checkout PayPal call failed (status: ${err.status}, name: ${err.paypalName ?? "none"}, debug_id: ${err.debugId ?? "none"})`
    );
  } else if (err instanceof PayPalConfigError) {
    console.error("commercial-checkout PayPal call failed (config)");
  } else {
    console.error(`commercial-checkout failed (sqlstate: ${redactedErrorCode(err)})`);
  }
}

async function countOpenSubscriptionsSince(db: CommercialDb, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(commercialCheckoutsTable)
    .where(
      and(
        gte(commercialCheckoutsTable.createdAt, since),
        isNotNull(commercialCheckoutsTable.paypalSubscriptionId),
        sql`${commercialCheckoutsTable.decision} is distinct from 'activate'`
      )
    );
  return row?.n ?? 0;
}

/**
 * Global backstop first (no row, no PayPal call when it trips), then a
 * `commercial_checkouts` row, then the PayPal subscription, then the subscription id on the row. Buyers are never
 * refused on identity: duplicates are handled after payment by activation. A failure after the insert leaves the row undecided; retention
 * deletes undecided rows after 30 days.
 */
export async function startCommercialCheckout(
  db: CommercialDb,
  input: CommercialCheckoutInput,
  deps: StartCheckoutDeps = defaultDeps
): Promise<StartCheckoutResult> {
  try {
    if ((await countOpenSubscriptionsSince(db, new Date(Date.now() - HOUR_MS))) >= COMMERCIAL_CHECKOUT_GLOBAL_HOURLY_CAP) {
      console.error("commercial-checkout global cap reached");
      return { ok: false, reason: "busy" };
    }

    const base = checkoutReturnBase();
    const [row] = await db
      .insert(commercialCheckoutsTable)
      .values({
        plan: input.plan as CommercialPlan,
        email: input.email,
        name: input.name,
        organization: input.organization,
        termsVersion: DATASET_TERMS_VERSION,
      })
      .returning({ id: commercialCheckoutsTable.id });

    const { subscriptionId, approveUrl } = await deps.createSubscription({
      plan: input.plan,
      checkoutId: row.id,
      returnUrl: `${base}/api/access/checkout/return?checkout=${row.id}`,
      cancelUrl: `${base}/access/commercial?cancelled=1`,
    });
    await db
      .update(commercialCheckoutsTable)
      .set({ paypalSubscriptionId: subscriptionId })
      .where(eq(commercialCheckoutsTable.id, row.id));
    return { ok: true, approveUrl };
  } catch (err) {
    logFailure(err);
    return { ok: false, reason: "unavailable" };
  }
}
