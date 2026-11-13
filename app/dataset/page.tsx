import type { Metadata } from "next";
import Link from "next/link";

import { Breadcrumb } from "@/components/breadcrumb";
import { DatasetCounts, editionChangesLine } from "@/components/dataset-counts";
import { PageMasthead } from "@/components/page-masthead";
import { formatPlanPrice } from "@/lib/commercial-plans";
import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { CSV_COLUMN_COUNT } from "@/lib/dataset-csv";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import {
  loadOfferCounts,
  loadOfferDateModified,
  loadOfferEdition,
  n,
} from "@/lib/dataset-offer";
import { breadcrumbJsonLdString, datasetJsonLdString } from "@/lib/seo";
import { MAX_ROWS } from "@/lib/table-query";
import { statesPhrase } from "@/lib/us-states";

export const revalidate = 86400;

// While the flag is off the page is a thin "not open yet" notice, so keep it out of the index.
export function generateMetadata(): Metadata {
  return {
    title: "Dataset",
    description: !isDatasetSharingEnabled()
      ? "Dataset access for Compute Atlas is not open yet."
      : isCommercialTierEnabled()
        ? `The full Compute Atlas dataset as weekly JSON and CSV files: free for students and educators, ${formatPlanPrice("monthly")} for everyone else.`
        : "The full Compute Atlas dataset as weekly JSON and CSV files, free for students and educators.",
    alternates: { canonical: "/dataset" },
    ...(isDatasetSharingEnabled() ? {} : { robots: { index: false, follow: false } }),
  };
}

const BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

/**
 * /dataset — the file offer ("Dataset" in the nav): what the files hold, the
 * free and commercial access cards, and why the commercial tier costs money.
 * How to cite and the license live on /data. While sharing is off the page
 * advertises nothing and is noindexed. Counts and the latest edition are read
 * only when sharing is on, through 24h-cached, fail-soft loaders, and the page
 * revalidates on its 86400s timer.
 */
export default async function DatasetPage() {
  const sharing = isDatasetSharingEnabled();
  const commercial = sharing && isCommercialTierEnabled();
  const [counts, edition, dateModified] = sharing
    ? await Promise.all([loadOfferCounts(), loadOfferEdition(), loadOfferDateModified()])
    : [null, null, undefined];
  const editionDetail = editionChangesLine(edition);

  return (
    <div
      data-content-width="3xl"
      className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbJsonLdString([
            { name: "Home", url: "/" },
            { name: "Map", url: "/map" },
            { name: "Dataset", url: "/dataset" },
          ]),
        }}
      />
      {sharing && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: datasetJsonLdString({ dateModified, commercial }),
          }}
        />
      )}

      <Breadcrumb items={[{ label: "Map", href: "/map" }, { label: "Dataset" }]} />

      {!sharing ? (
        <>
          <PageMasthead eyebrow="Weekly files" title="Dataset" />
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Dataset access is not open yet. For research or press questions, use the{" "}
            <Link href="/contact" className={LINK_CLASS}>
              contact page
            </Link>
            . How to credit the data is on{" "}
            <Link href="/data" className={LINK_CLASS}>
              Cite &amp; license
            </Link>
            .
          </p>
        </>
      ) : (
        <>
          <PageMasthead
            eyebrow="Weekly files"
            title="Dataset"
            dek="Every US data center, crypto-mining site and dedicated power plant Compute Atlas tracks, in one set of files, refreshed weekly. Source-cited, CC BY 4.0."
          />

          <section aria-labelledby="access-heading" className="space-y-4">
            <h2 id="access-heading" className="font-display text-2xl text-foreground">
              The full dataset
            </h2>
            <div className="space-y-1 font-mono text-sm text-foreground">
              <DatasetCounts counts={counts} edition={edition} noun="facilities" />
              {counts && (
                <p>
                  {`${n(counts.dataCenters)} data centers · ${n(counts.cryptoSites)} crypto-mining sites · ${n(counts.powerPlants)} power plants`}
                </p>
              )}
              {counts && (
                <p>
                  {`${statesPhrase(counts.stateCodes)} · ${n(counts.operators)} operators · ${n(counts.sourceLinks)} source links`}
                </p>
              )}
            </div>
            {editionDetail && (
              <p className="font-mono text-xs text-muted-foreground">{editionDetail}</p>
            )}
            <div className={commercial ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"}>
              <section
                aria-labelledby="free-access-heading"
                className="space-y-3 rounded-lg border border-border p-5"
              >
                <h3 id="free-access-heading" className="font-display text-xl text-foreground">
                  Free
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  For students and educators, verified by hand against a school email address. The
                  same weekly files through a personal link.
                </p>
                <Link href="/access?from=data" className={BUTTON_CLASS}>
                  Request access
                </Link>
              </section>
              {commercial && (
                <section
                  aria-labelledby="commercial-access-heading"
                  className="space-y-3 rounded-lg border border-border p-5"
                >
                  <h3
                    id="commercial-access-heading"
                    className="font-display text-xl text-foreground"
                  >
                    Commercial
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    For everyone else: companies, consultancies, investors, utilities, law firms,
                    journalists, nonprofits and government. {formatPlanPrice("monthly")} or{" "}
                    {formatPlanPrice("annual")}, plus applicable tax. Your download link arrives
                    as soon as payment completes. Cancel anytime. One link per subscription; for
                    a team,{" "}
                    <Link href="/contact" className={LINK_CLASS}>
                      contact us
                    </Link>
                    .
                  </p>
                  <Link href="/access/commercial" className={BUTTON_CLASS}>
                    Preview the files and plans
                  </Link>
                </section>
              )}
            </div>
          </section>

          <section
            aria-labelledby="what-files-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <h2 id="what-files-heading" className="font-display text-2xl text-foreground">
              What the files hold
            </h2>
            <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
              What the files give you that the site does not:
            </p>
            <ul className="max-w-2xl list-disc space-y-2 pl-5 text-base leading-relaxed text-muted-foreground">
              <li>
                <strong className="font-medium text-foreground">Everything at once.</strong> The
                site shows one facility at a time, and the table stops at {n(MAX_ROWS)} rows for
                any search. The files hold every record.
              </li>
              <li>
                <strong className="font-medium text-foreground">Every field.</strong>{" "}
                {CSV_COLUMN_COUNT}{" "}
                CSV columns per facility (status, operator, address and
                coordinates, operational and planned MW, energy source and utility, cooling, water
                use, investment, acreage, jobs, dates) plus, in JSON, each record&apos;s status
                history, emissions, subsidies and full source citations.
              </li>
              <li>
                <strong className="font-medium text-foreground">Siting context.</strong> Nearest
                surface water and ≥230 kV transmission line, basin water stress and aquifer, per
                facility, keyed by facility id.
              </li>
              <li>
                <strong className="font-medium text-foreground">What changed.</strong> Each weekly
                edition ships a changelog of records added, updated and removed.
              </li>
              <li>
                <strong className="font-medium text-foreground">The sources.</strong> Every record
                carries the public filings behind it: permits, rate cases, county agendas, press
                releases.
              </li>
            </ul>
          </section>

          {commercial && (
            <section
              aria-labelledby="why-paid-heading"
              className="space-y-4 border-t border-border pt-10"
            >
              <h2 id="why-paid-heading" className="font-display text-2xl text-foreground">
                Why it costs money
              </h2>
              <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
                The data is CC BY 4.0 for everyone, and a subscription does not change that: the
                fee pays for the work, not a license. Finding, reading and citing{" "}
                {counts ? n(counts.sourceLinks) : "thousands of"} public sources, checking for
                changes every week and delivering clean files is the work. Commercial
                subscriptions pay for it and keep the files free for students and
                educators. The map and every facility page stay free for everyone.
              </p>
            </section>
          )}

          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            How to credit the data, and the license terms, are on{" "}
            <Link href="/data" className={LINK_CLASS}>
              Cite &amp; license
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
