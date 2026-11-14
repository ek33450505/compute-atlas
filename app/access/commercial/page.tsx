import type { Metadata } from "next";
import Link from "next/link";

import { DatasetCounts, editionChangesLine } from "@/components/dataset-counts";
import { PageMasthead } from "@/components/page-masthead";
import { COMMERCIAL_PLANS, formatPlanPrice, type CommercialPlanKey } from "@/lib/commercial-plans";
import { isCommercialCheckoutOpen } from "@/lib/commercial-flag";
import { CSV_COLUMN_COUNT, CSV_COLUMNS, CSV_COLUMN_NOTES, facilitiesToCsv } from "@/lib/dataset-csv";
import {
  formatMegabytes,
  loadOfferCounts,
  loadOfferEdition,
  loadOfferSamples,
  n,
} from "@/lib/dataset-offer";
import { formatEditionDate } from "@/lib/edition-date";
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

const PRE_CLASS = "max-w-full overflow-x-auto rounded-md border border-input bg-muted p-3 text-xs leading-relaxed";
const SUMMARY_CLASS =
  "cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const TYPE_LABELS: Readonly<Record<string, string>> = {
  data_center: "data center",
  crypto_mining: "crypto-mining site",
  power_generation: "power plant",
};

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
  const [counts, edition, samples] = await Promise.all([loadOfferCounts(), loadOfferEdition(), loadOfferSamples()]);
  const editionChanges = editionChangesLine(edition);
  const jsonBytes = edition?.fileBytes["facilities.json"];
  const csvBytes = edition?.fileBytes["facilities.csv"];

  return (
    <AccessShell>
      <PageMasthead
        eyebrow="Data"
        title="The full dataset, every week"
        dek={`US data centers, crypto-mining sites and power plants, every field and every source, as JSON and CSV files refreshed weekly. ${formatPlanPrice("monthly")} or ${formatPlanPrice("annual")}, plus applicable tax. Cancel anytime.`}
      />

      <DatasetCounts
        counts={counts}
        edition={edition}
        noun="facilities"
        className="font-mono text-xs text-muted-foreground"
      />
      {editionChanges && (
        <p className="font-mono text-xs text-muted-foreground">{editionChanges}</p>
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
            siting-context.json: nearest water and transmission, basin water stress and aquifer per
            facility, plus join keys where computed (county FIPS, EPA eGRID2023 subregion, and
            census tract for exactly pinned sites)
          </li>
          <li>changelog.json: records added, updated and removed since the previous edition</li>
          <li>A new edition every Friday, and an email when it is ready</li>
          <li>One personal download link, sent by email as soon as payment completes</li>
        </ul>
      </section>

      <section aria-labelledby="commercial-preview" className="space-y-6">
        <h2 id="commercial-preview" className="text-lg font-medium">
          See what&apos;s in it
        </h2>

        <div className="max-w-2xl space-y-2">
          <h3 className="text-sm font-medium">The {CSV_COLUMN_COUNT} CSV columns</h3>
          <details className="rounded-lg border border-input p-3">
            <summary className={SUMMARY_CLASS}>Column list, in file order</summary>
            <dl className="mt-3 space-y-2 text-sm">
              {CSV_COLUMNS.map((column) => (
                <div key={column}>
                  <dt className="break-all font-mono text-xs">{column}</dt>
                  <dd className="text-muted-foreground">{CSV_COLUMN_NOTES[column]}</dd>
                </div>
              ))}
            </dl>
          </details>
          <p className="text-sm leading-relaxed text-muted-foreground">
            A column that does not apply to a facility&apos;s type is an empty cell. The JSON file also
            carries status history, emissions, subsidies, stakeholders and each source&apos;s label and date.
          </p>
        </div>

        {samples && samples.length > 0 ? (
          <div className="max-w-2xl space-y-3">
            <h3 className="text-sm font-medium">Sample records</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Records from the live dataset, in the same format as facilities.json, then as rows in
              the format of facilities.csv.
            </p>
            {samples.map((record) => (
              <details key={record.id} className="rounded-lg border border-input p-3">
                <summary className={SUMMARY_CLASS}>
                  {record.name} ({TYPE_LABELS[record.facilityType] ?? record.facilityType})
                </summary>
                <pre role="region" tabIndex={0} aria-label={`${record.name} as JSON`} className={`mt-3 ${PRE_CLASS}`}>
                  {JSON.stringify(record, null, 2)}
                </pre>
              </details>
            ))}
            <details className="rounded-lg border border-input p-3">
              <summary className={SUMMARY_CLASS}>The same records as CSV rows</summary>
              <pre role="region" tabIndex={0} aria-label="Sample records as CSV" className={`mt-3 ${PRE_CLASS}`}>
                {facilitiesToCsv(samples)}
              </pre>
            </details>
          </div>
        ) : null}

        <div className="max-w-2xl space-y-2">
          <h3 className="text-sm font-medium">What the weekly changelog looks like</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Each edition&apos;s changelog.json lists the records added, updated and removed since the
            previous edition. Every entry carries the record&apos;s id and, where known, its name and
            state, and an updated entry also lists the names of the fields that changed. The entries
            carry no old or new values; an edition&apos;s summary headlines may show a status change as before → after.
          </p>
          {edition && edition.initial ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              The latest edition is the first, so there is nothing yet to compare it against.
            </p>
          ) : null}
          {edition && !edition.initial && edition.headlines.length > 0 ? (
            <>
              <p className="text-sm text-muted-foreground">
                Headlines from the edition of {formatEditionDate(edition.date)}:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
                {edition.headlines.map((headline, index) => (
                  <li key={`${index}-${headline}`}>{headline}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
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
          className="space-y-6"
        >
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Plan</legend>
            <div className="grid max-w-xl gap-3 sm:grid-cols-2">
              {PLAN_ORDER.map((plan, index) => (
                <label
                  key={plan}
                  htmlFor={`plan-${plan}`}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-4 hover:bg-muted has-[:checked]:border-2 has-[:checked]:border-primary has-[:checked]:p-[15px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="radio"
                    id={`plan-${plan}`}
                    name="plan"
                    value={plan}
                    required
                    defaultChecked={index === 0}
                    className="mt-1 size-4 shrink-0 accent-primary"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{COMMERCIAL_PLANS[plan].label}</span>
                    <span className="font-display text-xl text-foreground">{formatPlanPrice(plan)}</span>
                    <span className="text-xs text-muted-foreground">plus applicable tax</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="checkout-email" className="text-sm font-medium">
              Email
            </label>
            <input id="checkout-email" name="email" type="email" required maxLength={254} autoComplete="email" className={FIELD_CLASS} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="checkout-name" className="text-sm font-medium">
              Name
            </label>
            <input id="checkout-name" name="name" type="text" required maxLength={200} autoComplete="name" className={FIELD_CLASS} />
          </div>
          <div className="flex flex-col gap-1.5">
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
          <div className="flex max-w-md items-start gap-2">
            <input
              type="checkbox"
              id="checkout-terms"
              name="acceptTerms"
              required
              className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            <label htmlFor="checkout-terms" className="text-sm leading-snug">
              I agree to the{" "}
              <Link href="/access/terms" className={ACCESS_LINK_CLASS}>
                terms
              </Link>
              .
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="submit"
              className="min-h-11 w-full max-w-md rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Continue to PayPal
            </button>
            <p className="text-sm text-muted-foreground">You&apos;ll finish on PayPal.</p>
          </div>
        </form>
      </section>

      <section aria-labelledby="commercial-compare" className="space-y-3">
        <h2 id="commercial-compare" className="text-lg font-medium">
          Compared with assembling it yourself
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Every record here started as a public document. Rebuilding the dataset means finding and
          reading {counts ? `${n(counts.sourceLinks)} of them (counted ${formatEditionDate(counts.asOf)})` : "thousands of them"}, then re-checking every
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
            The fee is not a license fee.
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
            Students and educators: access is free and reviewed by hand against a school email address. See{" "}
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
