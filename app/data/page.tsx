import type { Metadata } from "next";
import Link from "next/link";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { breadcrumbJsonLdString } from "@/lib/seo";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";

export const revalidate = 86400;

export const metadata: Metadata = {
  title: "How to cite Compute Atlas",
  description:
    "How to cite Compute Atlas and its individual facility pages: attribution line, license, and access date.",
  alternates: { canonical: "/data" },
};

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

/**
 * /data — the citation page: how to cite the site and an individual facility
 * page, the license statement, and the access date. The route keeps
 * its path for inbound links. The page loads no facility data and revalidates
 * on its 86400s timer only.
 *
 * Deliberately does NOT emit Dataset JSON-LD — that already lives site-wide
 * on the homepage; duplicating it here would be redundant.
 */
export default function DataPage() {
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
            { name: "Cite", url: "/data" },
          ]),
        }}
      />

      <Breadcrumb items={[{ label: "Cite" }]} />

      <PageMasthead
        eyebrow="CITATION"
        title="How to cite Compute Atlas"
        dek="The attribution line for the site and for an individual facility page, the license, and the access date."
      />

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
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          If it saved you time,{" "}
          <Link href="/support" className={LINK_CLASS}>
            support keeps it running
          </Link>
          . Institutions that rely on it can support it with a Ko-fi institution
          membership, and can be named on the support page if they ask to be.
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
