import type { Metadata } from "next";
import Link from "next/link";

import { getDatasetEdition } from "@/lib/dataset-edition";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { Download } from "lucide-react";
import { breadcrumbJsonLdString, DATASET_DOI_URL } from "@/lib/seo";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "Get the data",
  description:
    "Download the full Compute Atlas dataset free under CC-BY-4.0 — every tracked facility " +
      "in the deployed snapshot, no login, no sign-up, no query building.",
  alternates: { canonical: "/data" },
};

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

const DOWNLOAD_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-sm border border-border bg-background px-3 " +
  "text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

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
 * everything."
 *
 * The page does NOT load the facility array (it used to ship ~6 MB into the
 * RSC payload just to build a blob on click). The downloads are plain links
 * to static files that `scripts/build-data-exports.ts` generates on prebuild
 * from data/facilities.json. Trade-off: those files come from the bundled
 * snapshot, so they can lag live Neon until the next code deploy (data-only
 * merges skip builds). The visible copy says so plainly: the files are a
 * snapshot published with each deploy and can trail the live site. The "as of"
 * date shown comes from data/facilities.meta.json; nothing claims the files and
 * the page are content-identical (`version` below is only a cache-busting key).
 * With no loadFacilities call the page carries no "facilities" cache tag; it
 * revalidates on its 86400s timer only, which is fine for static prose.
 *
 * Deliberately does NOT emit Dataset JSON-LD — that already lives site-wide
 * on the homepage; duplicating it here would be redundant.
 */
export default function DataPage() {
  const edition = getDatasetEdition();
  const asOfLabel = formatAsOf(edition.asOf);
  const count = edition.recordCount.toLocaleString("en-US");
  // The files are edge-cached for a day under /data/:path+, so the URL carries
  // the snapshot's asOf: a fresh page links to a URL no older cache entry can
  // hold, so a fresh page never gets a stale cached file. One direction only:
  // an old edge-cached page linking ?v=OLD still fetches the CURRENT files,
  // because the origin only ever holds the current build. (The static file
  // server ignores the query.) Omitted when asOf is unusable.
  const version = asOfLabel ? `?v=${encodeURIComponent(edition.asOf)}` : "";

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
        dek={
          "The full dataset, free to download — no login, no sign-up, no query building, " +
          "no explanation required."
        }
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
          {count} facilities
          {asOfLabel ? `, as of ${asOfLabel}` : ""}.
        </p>
        <div
          role="group"
          aria-label="Download the dataset"
          className="flex flex-wrap items-center gap-2"
        >
          <a
            href={`/data/facilities.csv${version}`}
            download="compute-atlas-facilities.csv"
            aria-label={`Download CSV: all ${count} facilities`}
            className={DOWNLOAD_CLASS}
          >
            <Download className="size-4" aria-hidden="true" />
            Download CSV
          </a>
          <a
            href={`/data/facilities.json${version}`}
            download="compute-atlas-facilities.json"
            aria-label={`Download JSON: all ${count} facilities`}
            className={DOWNLOAD_CLASS}
          >
            <Download className="size-4" aria-hidden="true" />
            Download JSON
          </a>
        </div>
        <p className="text-xs text-muted-foreground">
          {asOfLabel
            ? `Both files are a snapshot as of ${asOfLabel}, ` +
              "published with each site deploy."
            : "Both files are a snapshot published with each site deploy."}{" "}
          They can trail the live site until the next deploy. CSV is a flat table of the main
          fields; JSON has every field, including all sources.
        </p>
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
