import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { COMMERCIAL_PLANS, formatPlanPrice, type CommercialPlanKey } from "@/lib/commercial-plans";
import { isCommercialCheckoutOpen } from "@/lib/commercial-flag";
import { ACCESS_LINK_CLASS, AccessNotOpen, AccessShell } from "../not-open";

// While the flag is off the page is a thin "not open yet" notice, so keep it out of the index.
export function generateMetadata(): Metadata {
  return {
    title: "Commercial access to the dataset",
    description:
      "The full Compute Atlas dataset, refreshed weekly, through a personal download link, for companies, consultancies, investors and law firms.",
    alternates: { canonical: "/access/commercial" },
    ...(isCommercialCheckoutOpen() ? {} : { robots: { index: false, follow: false } }),
  };
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  plan: "That plan was not recognized. Choose one of the plans below.",
  details:
    "Check your details: a valid email address, your name and your organization are all required, and unsupported characters are not accepted.",
  request: "That request couldn't be processed. Please submit the form on this page.",
  terms: "Please agree to the terms to continue.",
  busy: "Checkout is busy right now. Please try again in a little while.",
  unavailable: "Checkout is temporarily unavailable. Please try again later.",
};

const PLAN_ORDER: readonly CommercialPlanKey[] = ["monthly", "annual"];

const FIELD_CLASS =
  "w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const INCLUDED = [
  "The full dataset, refreshed weekly (JSON and CSV)",
  "One personal download link per subscription, sent by email after payment",
  "Receipts from PayPal",
] as const;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * /access/commercial — self-serve paid access. One plain HTML form posts to /api/access/checkout, which
 * answers with a 303 to PayPal, so the page needs no client JS. The flag only decides which copy
 * renders; the route enforces it independently.
 */
export default async function CommercialAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isCommercialCheckoutOpen()) return <AccessNotOpen />;

  const params = await searchParams;
  const errorKey = first(params.error);
  const errorMessage = errorKey !== undefined && Object.hasOwn(ERROR_MESSAGES, errorKey) ? ERROR_MESSAGES[errorKey] : undefined;
  const canceled = first(params.cancelled) === "1" || first(params.canceled) === "1";

  return (
    <AccessShell>
      <PageMasthead
        eyebrow="Data"
        title="Commercial access to the dataset"
        dek={
          <>
            The full Compute Atlas dataset (every record, JSON and CSV, refreshed weekly) through a
            personal download link, for companies, consultancies, investors and law firms. The data
            is licensed CC BY 4.0. Commercial users pay for the research, discovery, weekly
            delivery and hosting that keep the data free for education, journalism and the public
            interest.
          </>
        }
      />

      {errorMessage ? (
        <p id="checkout-error" role="alert" className="max-w-2xl rounded-lg border border-input p-4 text-sm">
          {errorMessage}
        </p>
      ) : null}
      {canceled && !errorMessage ? (
        <p role="status" className="max-w-2xl rounded-lg border border-input p-4 text-sm">
          Checkout was cancelled; nothing was charged.
        </p>
      ) : null}

      <section aria-labelledby="commercial-plans" className="space-y-4">
        <h2 id="commercial-plans" className="text-lg font-medium">
          Plans
        </h2>
        <form
          method="post"
          action="/api/access/checkout"
          aria-describedby={errorMessage ? "checkout-error" : undefined}
          className="space-y-5"
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Plan</legend>
            {PLAN_ORDER.map((plan, index) => (
              <div key={plan} className="flex items-start gap-2">
                <input
                  type="radio"
                  id={`plan-${plan}`}
                  name="plan"
                  value={plan}
                  required
                  defaultChecked={index === 0}
                  className="mt-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
                <label htmlFor={`plan-${plan}`} className="text-sm">
                  <span className="font-medium">{COMMERCIAL_PLANS[plan].label}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {formatPlanPrice(plan)} · plus applicable tax.
                  </span>
                </label>
              </div>
            ))}
          </fieldset>
          <div className="space-y-1">
            <label htmlFor="checkout-email" className="text-sm font-medium">
              Email
            </label>
            <input id="checkout-email" name="email" type="email" required maxLength={254} autoComplete="email" className={FIELD_CLASS} />
          </div>
          <div className="space-y-1">
            <label htmlFor="checkout-name" className="text-sm font-medium">
              Name
            </label>
            <input id="checkout-name" name="name" type="text" required maxLength={200} autoComplete="name" className={FIELD_CLASS} />
          </div>
          <div className="space-y-1">
            <label htmlFor="checkout-organization" className="text-sm font-medium">
              Organization
            </label>
            <input
              id="checkout-organization"
              name="organization"
              type="text"
              required
              maxLength={200}
              autoComplete="organization"
              className={FIELD_CLASS}
            />
          </div>
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="checkout-terms"
              name="acceptTerms"
              required
              className="mt-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            <label htmlFor="checkout-terms" className="text-sm">
              I agree to the{" "}
              <Link href="/access/terms" className={ACCESS_LINK_CLASS}>
                terms
              </Link>
              .
            </label>
          </div>
          <p className="text-sm text-muted-foreground">You&apos;ll finish on PayPal; a PayPal account is required.</p>
          <button
            type="submit"
            className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Continue to PayPal
          </button>
        </form>
      </section>

      <section aria-labelledby="commercial-included" className="space-y-3">
        <h2 id="commercial-included" className="text-lg font-medium">
          What is included
        </h2>
        <ul className="max-w-2xl list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
          {INCLUDED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The data is CC BY 4.0 for everyone, and a subscription does not change that. It
          pays for weekly delivery in ready-to-use files, and for the research, discovery
          and hosting behind them.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Need access for a team?{" "}
          <Link href="/contact" className={ACCESS_LINK_CLASS}>
            Contact us
          </Link>
          .
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Cancel anytime from your PayPal account; access runs to the end of the paid period. No
          refunds for partial periods, except where the law requires one.{" "}
          <Link href="/access/terms" className={ACCESS_LINK_CLASS}>
            Commercial access terms
          </Link>
          .
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Payment is handled by PayPal. Compute Atlas never sees your payment details.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Access for students, academics, journalists, nonprofits and government is free and
          approved by hand: see{" "}
          <Link href="/access" className={ACCESS_LINK_CLASS}>
            dataset access
          </Link>
          .
        </p>
      </section>
    </AccessShell>
  );
}
