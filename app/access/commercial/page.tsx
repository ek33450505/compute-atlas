import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { COMMERCIAL_PLANS, formatPlanPrice, type CommercialPlanKey } from "@/lib/commercial-plans";
import { isCommercialCheckoutOpen } from "@/lib/commercial-flag";
import { CSV_COLUMN_COUNT } from "@/lib/dataset-csv";
import { formatEditionDate, formatMegabytes, loadOfferCounts, loadOfferEdition, n } from "@/lib/dataset-offer";
import { ACCESS_LINK_CLASS, AccessNotOpen, AccessShell } from "../not-open";

// While the flag is off the page is a thin "not open yet" notice, so keep it out of the index.
export function generateMetadata(): Metadata {
  return {
    title: "Commercial access to the dataset",
    description:
      `The full Compute Atlas dataset of US data centers, crypto-mining sites and power plants: weekly JSON and CSV files with sources and a changelog. ${formatPlanPrice("monthly")} or ${formatPlanPrice("annual")}.`,
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
  const [counts, edition] = await Promise.all([loadOfferCounts(), loadOfferEdition()]);
  const jsonBytes = edition?.fileBytes["facilities.json"];
  const csvBytes = edition?.fileBytes["facilities.csv"];

  return (
    <AccessShell>
      <PageMasthead
        eyebrow="Data"
        title="The full dataset, every week"
        dek={`${counts ? `${n(counts.facilities)} ` : ""}US data centers, crypto-mining sites and power plants, every field and every source, as JSON and CSV files refreshed weekly. ${formatPlanPrice("monthly")} or ${formatPlanPrice("annual")}, plus applicable tax. Cancel anytime.`}
      />

      {edition && (
        <p className="font-mono text-xs text-muted-foreground">
          {[
            `Latest edition ${formatEditionDate(edition.date)}`,
            edition.recordCount !== null ? `${n(edition.recordCount)} records` : null,
            !edition.initial && edition.added !== null ? `${n(edition.added)} added` : null,
            !edition.initial && edition.updated !== null ? `${n(edition.updated)} updated` : null,
            !edition.initial && edition.removed !== null ? `${n(edition.removed)} removed` : null,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </p>
      )}

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

      <section aria-labelledby="commercial-included" className="space-y-3">
        <h2 id="commercial-included" className="text-lg font-medium">
          What you get
        </h2>
        <ul className="max-w-2xl list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li>
            facilities.json: every record with every field, including status history, emissions,
            subsidies, stakeholders and full source citations
            {jsonBytes !== undefined ? ` (${formatMegabytes(jsonBytes)})` : ""}
          </li>
          <li>
            facilities.csv: the same records as a {CSV_COLUMN_COUNT}-column table, ready for a
            spreadsheet{csvBytes !== undefined ? ` (${formatMegabytes(csvBytes)})` : ""}
          </li>
          <li>
            siting-context.json: nearest water and transmission, basin water stress and aquifer,
            per facility
          </li>
          <li>changelog.json: records added, updated and removed since the previous edition</li>
          <li>A new edition every Saturday, and an email when it is ready</li>
          <li>One personal download link, sent by email as soon as payment completes</li>
        </ul>
      </section>

      <section aria-labelledby="commercial-users" className="space-y-3">
        <h2 id="commercial-users" className="text-lg font-medium">
          Who uses it
        </h2>
        <ul className="max-w-2xl list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li>Site selection and development: where projects are proposed, by whom, near which grid and water.</li>
          <li>Utilities and energy: announced load, on-site generation and the utility named in each filing.</li>
          <li>Investors and analysts: the pipeline by status, operator and state, with a weekly changelog to track it.</li>
          <li>Law, policy and newsrooms: the permits, rate cases and county decisions behind each site.</li>
        </ul>
      </section>

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
          <p className="text-sm text-muted-foreground">You&apos;ll finish on PayPal.</p>
          <button
            type="submit"
            className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Continue to PayPal
          </button>
        </form>
      </section>

      <section aria-labelledby="commercial-compare" className="space-y-3">
        <h2 id="commercial-compare" className="text-lg font-medium">
          Compared with assembling it yourself
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Every record here started as a public document. Rebuilding the dataset means finding and
          reading {counts ? n(counts.sourceLinks) : "thousands"} of them, then re-checking every
          week. If you need a handful of facilities, the free{" "}
          <Link href="/table" className={ACCESS_LINK_CLASS}>
            table
          </Link>{" "}
          and facility pages may be all you need.
        </p>
      </section>

      <section aria-labelledby="commercial-terms" className="space-y-3">
        <h2 id="commercial-terms" className="text-lg font-medium">
          Terms in plain words
        </h2>
        <ul className="max-w-2xl list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li>
            The data is CC BY 4.0 for everyone: reuse it, including commercially, with attribution.
            The fee is not a licence fee.
          </li>
          <li>
            Cancel anytime from your PayPal account; access runs to the end of the paid period. No
            refunds for partial periods, except where the law requires one.{" "}
            <Link href="/access/terms" className={ACCESS_LINK_CLASS}>
              Commercial access terms
            </Link>
            .
          </li>
          <li>Payment is handled by PayPal; a PayPal account is required. Compute Atlas never sees your payment details.</li>
          <li>
            One named person per subscription. For a team,{" "}
            <Link href="/contact" className={ACCESS_LINK_CLASS}>
              contact us
            </Link>
            .
          </li>
          <li>
            Students, educators and academics: access is free and reviewed by hand. See{" "}
            <Link href="/access" className={ACCESS_LINK_CLASS}>
              dataset access
            </Link>
            .
          </li>
        </ul>
      </section>
    </AccessShell>
  );
}
