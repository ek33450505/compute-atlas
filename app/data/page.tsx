import type { Metadata } from "next";
import Link from "next/link";

import { getAllFacilities } from "@/lib/data";
import { getDatasetEdition } from "@/lib/dataset-edition";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { ExportButtons } from "@/components/explorer/export-buttons";
import { breadcrumbJsonLdString, DATASET_DOI_URL } from "@/lib/seo";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Get the data",
  description:
    "Download the full Compute Atlas dataset for free, under CC-BY-4.0 — every tracked facility, no login, no query parameters, no explanation required.",
  alternates: { canonical: "/data" },
};

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * Formats `DatasetEdition.asOf` for display. `asOf` can be the literal
 * string "unknown" (see lib/dataset-edition.ts's FALLBACK_EDITION) or an
 * unparseable value — both render nothing rather than "Invalid Date".
 */
function formatAsOf(asOf: string): string | null {
  if (asOf === "unknown") return null;
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * /data — plain-language front door to the full dataset download. Built for
 * an audience that doesn't know what an API is: "click here, get
 * everything." Reuses the same <ExportButtons> /table's filter UI uses, but
 * fed the FULL unfiltered facility list and none of the filter chrome.
 *
 * Deliberately does NOT emit Dataset JSON-LD — that already lives site-wide
 * on the homepage; duplicating it here would be redundant.
 */
export default async function DataPage() {
  const [facilities, edition] = await Promise.all([
    getAllFacilities(),
    Promise.resolve(getDatasetEdition()),
  ]);
  const asOfLabel = formatAsOf(edition.asOf);

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
            { name: "Get the data", url: "/data" },
          ]),
        }}
      />

      <Breadcrumb items={[{ label: "Get the data" }]} />

      <PageMasthead
        eyebrow="DATASET"
        title="Get the data"
        dek="The full dataset, free to download — no login, no query parameters, no explanation required."
      />

      {/* Primary download — the whole point of the page, above everything else */}
      <section
        aria-labelledby="download-heading"
        className="neatline rounded-sm border border-primary/40 bg-muted/20 p-6 sm:p-8 space-y-4"
      >
        <h2 id="download-heading" className="font-display text-2xl text-foreground">
          Download everything
        </h2>
        <p className="text-sm text-muted-foreground">
          {edition.recordCount.toLocaleString("en-US")} facilities
          {asOfLabel ? `, as of ${asOfLabel}` : ""}.
        </p>
        <ExportButtons facilities={facilities} />
      </section>

      <section aria-labelledby="what-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § What this is
        </p>
        <h2 id="what-heading" className="font-display text-2xl text-foreground">
          What this is
        </h2>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Compute Atlas is an open, source-cited record of data centers, AI-specific
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
            aria-label="Creative Commons Attribution 4.0 (CC-BY) license (opens in new tab)"
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
          How to cite
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
          Link www.compute-atlas.com, the dataset&apos;s home, rather than the GitHub
          repository. Say if you changed anything (for example, filtered or joined the
          records). Compute Atlas is non-partisan and takes no position on any facility,
          so keep your own analysis or commentary distinct from its records.
        </p>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          For academic citation, the dataset has a permanent identifier that always
          resolves to its latest version:
        </p>
        <blockquote className="max-w-2xl border-l-2 border-border pl-4 font-mono text-sm text-muted-foreground">
          Kubiak, E. (n.d.). Compute Atlas [Data set].{" "}
          <a href={DATASET_DOI_URL} className={LINK_CLASS}>
            {DATASET_DOI_URL}
          </a>
        </blockquote>
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

      <section
        aria-labelledby="different-heading"
        className="space-y-4 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Need something different?
        </p>
        <h2 id="different-heading" className="font-display text-2xl text-foreground">
          Need something different?
        </h2>
        <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
          Looking for an API, rate limits, or programmatic access instead? See the{" "}
          <Link href="/api" className={LINK_CLASS}>
            developer docs →
          </Link>
        </p>
      </section>
    </div>
  );
}
