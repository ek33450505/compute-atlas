import type { Metadata } from "next";
import Link from "next/link";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { formatPlanPrice } from "@/lib/commercial-plans";
import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { CSV_COLUMN_COUNT } from "@/lib/dataset-csv";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import {
  formatEditionDate,
  loadOfferCounts,
  loadOfferEdition,
  n,
  type OfferEdition,
} from "@/lib/dataset-offer";
import { breadcrumbJsonLdString } from "@/lib/seo";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";
import { MAX_ROWS } from "@/lib/table-query";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Data",
  description:
    `Get the full Compute Atlas dataset as weekly JSON and CSV files: free for students, educators and academics, ${formatPlanPrice("monthly")} for everyone else. How to cite it.`,
  alternates: { canonical: "/data" },
};

const BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

/** "Latest edition: 10 November 2026: 7 added, 8 updated." A first edition has no changes to report. */
function editionLine(edition: OfferEdition): string {
  const head = `Latest edition: ${formatEditionDate(edition.date)}`;
  const parts = edition.initial
    ? [edition.recordCount !== null ? `${n(edition.recordCount)} records` : null]
    : [
        edition.added !== null ? `${n(edition.added)} added` : null,
        edition.updated !== null ? `${n(edition.updated)} updated` : null,
        edition.removed !== null ? `${n(edition.removed)} removed` : null,
      ];
  const clauses = parts.filter((part) => part !== null);
  return clauses.length > 0 ? `${head}: ${clauses.join(", ")}.` : `${head}.`;
}

/**
 * /data — the dataset offer ("Cite" in the nav): what the files hold, the
 * free and commercial access cards, then how to cite the site and an
 * individual facility page and the license statement. The route keeps its
 * path for inbound links. Counts and the latest edition are read only when
 * sharing is on, through 24h-cached, fail-soft loaders, and the page
 * revalidates on its 86400s timer.
 *
 * Deliberately does NOT emit Dataset JSON-LD — that already lives site-wide
 * on the homepage; duplicating it here would be redundant.
 */
export default async function DataPage() {
  const sharing = isDatasetSharingEnabled();
  const commercial = sharing && isCommercialTierEnabled();
  const [counts, edition] = sharing
    ? await Promise.all([loadOfferCounts(), loadOfferEdition()])
    : [null, null];

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
            { name: "Data", url: "/data" },
          ]),
        }}
      />

      <Breadcrumb items={[{ label: "Data" }]} />

      <PageMasthead
        eyebrow="DATA"
        title="Data"
        dek="Every US data center, crypto-mining site and dedicated power plant Compute Atlas tracks, in one set of files, refreshed weekly. Source-cited, CC BY 4.0."
      />

      {sharing && (
        <section aria-labelledby="access-heading" className="space-y-4">
          <h2 id="access-heading" className="font-display text-2xl text-foreground">
            The full dataset
          </h2>
          {counts && (
            <div className="space-y-1 font-mono text-sm text-foreground">
              <p>
                {n(counts.facilities)} facilities · {n(counts.dataCenters)} data centers
                · {n(counts.cryptoSites)} crypto-mining sites ·{" "}
                {n(counts.powerPlants)} power plants
              </p>
              <p>
                {n(counts.states)} states and territories · {n(counts.operators)} operators
                · {n(counts.sourceLinks)} source links
              </p>
            </div>
          )}
          {edition && (
            <p className="font-mono text-xs text-muted-foreground">
              {editionLine(edition)}
            </p>
          )}
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
            What the files give you that the site does not:
          </p>
          <ul className="max-w-2xl list-disc space-y-2 pl-5 text-base leading-relaxed text-muted-foreground">
            <li>
              <strong className="font-medium text-foreground">Everything at once.</strong> The site
              shows one facility at a time, and the table stops at {n(MAX_ROWS)} rows for any
              search. The files hold every record.
            </li>
            <li>
              <strong className="font-medium text-foreground">Every field.</strong> {CSV_COLUMN_COUNT}{" "}
              CSV columns per facility (status, operator, address and coordinates, operational and
              planned MW, energy source and utility, cooling, water use, investment, acreage, jobs,
              dates) plus, in JSON, each record&apos;s status history, emissions, subsidies and full
              source citations.
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
          <div className={commercial ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"}>
            <section
              aria-labelledby="free-access-heading"
              className="space-y-3 rounded-lg border border-border p-5"
            >
              <h3 id="free-access-heading" className="font-display text-xl text-foreground">
                Free
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                For students, educators and academics. The same weekly files through a personal
                link. Each request is reviewed by hand.
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
                <h3 id="commercial-access-heading" className="font-display text-xl text-foreground">
                  Commercial
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  For everyone else: companies, consultancies, investors, utilities, law firms,
                  journalists, nonprofits and government. {formatPlanPrice("monthly")} or{" "}
                  {formatPlanPrice("annual")}, plus applicable tax. Your download link arrives as
                  soon as payment completes. Cancel anytime. One link per subscription; for a team,{" "}
                  <Link href="/contact" className={LINK_CLASS}>
                    contact us
                  </Link>
                  .
                </p>
                <Link href="/access/commercial" className={BUTTON_CLASS}>
                  Get the dataset
                </Link>
              </section>
            )}
          </div>
        </section>
      )}

      {commercial && (
        <section aria-labelledby="why-paid-heading" className="space-y-4 border-t border-border pt-10">
          <h2 id="why-paid-heading" className="font-display text-2xl text-foreground">
            Why it costs money
          </h2>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
            The data is CC BY 4.0 for everyone, and a subscription does not change that: the fee
            pays for the work, not a licence. Finding, reading and citing{" "}
            {counts ? n(counts.sourceLinks) : "thousands of"} public sources, checking for changes
            every week and delivering clean files is the work. Commercial subscriptions pay for it
            and keep the files free for students, educators and academics. The map and every
            facility page stay free for everyone.
          </p>
        </section>
      )}

      <section aria-labelledby="what-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § What this is
        </p>
        <h2 id="what-heading" className="font-display text-2xl text-foreground">
          What this is
        </h2>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Compute Atlas is a source-cited record of data centers, AI-specific
          facilities, crypto-mining sites, and the power plants built to feed them, across
          the United States. Every record &mdash; from a site that&rsquo;s only proposed to
          one that&rsquo;s already running &mdash; is backed by a public source: a permit
          filing, a press release, a rate case, a county board agenda.
        </p>
      </section>

      <section aria-labelledby="license-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § License
        </p>
        <h2 id="license-heading" className="font-display text-2xl text-foreground">
          License
        </h2>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          The data is free to use, including commercially, under a{" "}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="CC BY 4.0: Creative Commons Attribution 4.0 license (opens in new tab)"
            className={LINK_CLASS}
          >
            CC BY 4.0
          </a>{" "}
          license, with attribution to Compute Atlas required.
        </p>
      </section>

      <section aria-labelledby="cite-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § How to cite
        </p>
        <h2 id="cite-heading" className="font-display text-2xl text-foreground">
          How to cite Compute Atlas
        </h2>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          To credit the data on a page, article, or derived dataset:
        </p>
        <blockquote className="max-w-2xl border-l-2 border-border pl-4 font-mono text-sm text-muted-foreground">
          Data from Compute Atlas by Edward Kubiak (
          <a
            href={siteConfig.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`${siteConfig.url} (opens in new tab)`}
            className={LINK_CLASS}
          >
            {siteConfig.url}
          </a>
          ), licensed under CC BY 4.0 (
          <a
            href={DATASET_LICENSE_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`${DATASET_LICENSE_URL} (opens in new tab)`}
            className={LINK_CLASS}
          >
            {DATASET_LICENSE_URL}
          </a>
          ).
        </blockquote>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Link www.compute-atlas.com, Compute Atlas&apos;s home. Say if you changed
          anything (for example, filtered or joined the records). Compute Atlas is
          non-partisan and takes no position on any facility, so keep your own
          analysis or commentary distinct from its records.
        </p>
        <h3 className="font-display text-xl text-foreground">Citing a facility page</h3>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          To cite a single record, name the facility and link its own page, then give
          the same attribution:
        </p>
        <blockquote className="max-w-2xl border-l-2 border-border pl-4 font-mono text-sm text-muted-foreground">
          &ldquo;[Facility name]&rdquo;, Compute Atlas, {siteConfig.url}/facilities/[id],
          accessed [date]. Licensed under CC BY 4.0.
        </blockquote>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Each record lists its own public sources. Cite those directly when a claim
          depends on them.
        </p>
      </section>

      <section aria-labelledby="scope-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Scope, briefly
        </p>
        <h2 id="scope-heading" className="font-display text-2xl text-foreground">
          Scope, briefly
        </h2>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Compute Atlas is a curated dataset, not a census &mdash; a facility&rsquo;s
          absence isn&rsquo;t evidence it doesn&rsquo;t exist. Collection began in July
          2026 with no cutoff date, but the public record it&rsquo;s built from
          (permits, filings, local reporting) is thicker for sites being proposed and
          built now than for older sites, so coverage skews recent. Operational
          (already-running) sites are the least completely dated cohort &mdash; many have
          simply been running for years with no public record of when. An empty field
          always means &ldquo;not established from a public source,&rdquo; never
          &ldquo;zero.&rdquo;
        </p>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          <Link href="/methodology" className={LINK_CLASS}>
            Read the full methodology →
          </Link>
        </p>
      </section>
    </div>
  );
}
