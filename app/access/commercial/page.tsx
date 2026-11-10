import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { COMMERCIAL_PLANS, COMMERCIAL_SEATS, formatPlanPrice, type CommercialPlanKey } from "@/lib/commercial-plans";
import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { ACCESS_LINK_CLASS, AccessNotOpen, AccessShell } from "../not-open";

// While the flag is off the page is a thin "not open yet" notice, so keep it out of the index.
export function generateMetadata(): Metadata {
  return {
    title: "Commercial access to the dataset",
    description:
      "The full Compute Atlas dataset, refreshed weekly, through a personal download link, for companies, consultancies, investors and law firms.",
    alternates: { canonical: "/access/commercial" },
    ...(isCommercialTierEnabled() ? {} : { robots: { index: false, follow: false } }),
  };
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  plan: "That plan was not recognized. Choose one of the plans below.",
  busy: "Too many checkout attempts from this network. Please try again later.",
  unavailable: "Checkout is temporarily unavailable. Please try again later.",
};

const PLAN_ORDER: readonly CommercialPlanKey[] = ["monthly", "annual"];

const PLAN_DETAIL: Record<CommercialPlanKey, { detail: string; button: string }> = {
  monthly: { detail: "Cancel anytime.", button: "Subscribe monthly" },
  annual: { detail: `${COMMERCIAL_PLANS.annual.note}.`, button: "Subscribe annually" },
};

const INCLUDED = [
  "The full dataset, refreshed weekly (JSON and CSV)",
  "A personal download link, sent by email after payment",
  `Internal use by up to ${COMMERCIAL_SEATS} people at the organization`,
  "Cancel any time from the billing portal; access runs to the end of the paid period",
  "Receipts and invoices from Stripe",
] as const;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * /access/commercial — self-serve paid access. Plain HTML forms post to /api/access/checkout, which
 * answers with a 303 to Stripe, so the page needs no client JS. The flag only decides which copy
 * renders; the route enforces it independently.
 */
export default async function CommercialAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isCommercialTierEnabled()) return <AccessNotOpen />;

  const params = await searchParams;
  const errorKey = first(params.error);
  const errorMessage = errorKey !== undefined && Object.hasOwn(ERROR_MESSAGES, errorKey) ? ERROR_MESSAGES[errorKey] : undefined;
  const canceled = first(params.canceled) === "1";

  return (
    <AccessShell>
      <PageMasthead
        eyebrow="Data"
        title="Commercial access to the dataset"
        dek={
          <>
            The full Compute Atlas dataset (every record, JSON and CSV, refreshed weekly) through a
            personal download link, for companies, consultancies, investors and law firms. The data
            is licensed CC BY 4.0, so the subscription pays for weekly delivery and upkeep, not for
            the license.
          </>
        }
      />

      {errorMessage ? (
        <p role="alert" className="max-w-2xl rounded-lg border border-input p-4 text-sm">
          {errorMessage}
        </p>
      ) : null}
      {canceled && !errorMessage ? (
        <p role="status" className="max-w-2xl rounded-lg border border-input p-4 text-sm">
          Checkout was canceled; nothing was charged.
        </p>
      ) : null}

      <section aria-labelledby="commercial-plans" className="space-y-4">
        <h2 id="commercial-plans" className="text-lg font-medium">
          Plans
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {PLAN_ORDER.map((plan) => (
            <form
              key={plan}
              method="post"
              action="/api/access/checkout"
              className="space-y-3 rounded-lg border border-input p-4"
            >
              <input type="hidden" name="plan" value={plan} />
              <h3 className="text-base font-medium">{COMMERCIAL_PLANS[plan].label}</h3>
              <p className="text-sm">
                <span className="font-medium">{formatPlanPrice(plan)}</span>
                <span className="text-muted-foreground"> · {PLAN_DETAIL[plan].detail}</span>
              </p>
              <button
                type="submit"
                className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {PLAN_DETAIL[plan].button}
              </button>
            </form>
          ))}
        </div>
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
          Payment is handled by Stripe. Compute Atlas never sees card details.
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
