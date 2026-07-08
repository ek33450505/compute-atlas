import type { Metadata } from "next";
import Link from "next/link";

import { STATUS_META, STATUS_ORDER } from "@/lib/status";
import { siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: "About & method",
  description:
    "Why Compute Atlas exists, how it is compiled, and the standards behind it — a community-driven, source-verified survey of U.S. AI-datacenter infrastructure.",
};

export default function AboutPage() {
  return (
    <div data-content-width="3xl" className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16 space-y-12">
      {/* ---- Masthead ---- */}
      <header className="relative">
        <div
          aria-hidden="true"
          className="graticule pointer-events-none absolute inset-0 opacity-40 [mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]"
        />
        <div className="relative space-y-4 pb-8">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            Manifesto &amp; method · Edition 2026
          </p>
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
            Public, but scattered.
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
            Compute Atlas is a community-driven, open, source-verified survey of
            the AI-datacenter buildout across the United States — where it is
            being built, by whom, and at what cost to energy, water, and the
            communities nearby.
          </p>
        </div>
        <div className="border-t border-border" />
      </header>

      {/* ---- Manifesto ---- */}
      <section aria-labelledby="manifesto-heading" className="space-y-8">
        <h2 id="manifesto-heading" className="sr-only">
          Manifesto
        </h2>

        <div className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            § The problem
          </p>
          <h3 className="font-display text-2xl text-foreground">
            The information is public. Assembling it is the hard part.
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The facts about any given datacenter are, in principle, on the
            record — scattered across county permit filings, tax-abatement
            agreements, water-authority applications, interconnection queues,
            and local news. No one keeps them in one place. Gathering them,
            cross-checking them, and turning them into something comparable is
            genuinely difficult work. That difficulty is the problem this atlas
            exists to solve.
          </p>
        </div>

        <div className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            § The method
          </p>
          <h3 className="font-display text-2xl text-foreground">
            A source for every record.
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every field traces back to a public source, cited on the facility&rsquo;s
            page. We record what the documents say and no more: ranges and
            projections are marked as estimates, not presented as fact; where a
            figure genuinely isn&rsquo;t known, the record says so rather than
            guessing. Nothing here is fabricated or inferred beyond what a reader
            can check for themselves.
          </p>
        </div>

        <div className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            § The invitation
          </p>
          <h3 className="font-display text-2xl text-foreground">
            Built in the open, correctable by anyone.
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The code and the data are public, and the atlas is meant to be
            stewarded by the people who use it — journalists, researchers, local
            officials, and residents. If a record is wrong, incomplete, or
            missing, you can fix it. Every contribution needs one thing: a
            public source anyone can verify.
          </p>
        </div>

        <div className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            § The stance
          </p>
          <h3 className="font-display text-2xl text-foreground">
            Non-partisan, and not affiliated with anyone.
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Compute Atlas takes no editorial position on whether any facility
            should be built. It is not affiliated with any company, advocacy
            group, or government agency. The aim is a factual, honest starting
            point — what to make of it is up to the reader.{" "}
            <a
              href={siteConfig.repoUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="View the source code and data on GitHub (opens in new tab)"
              className="underline underline-offset-2 hover:text-foreground"
            >
              The source code and data are public.
            </a>
          </p>
        </div>
      </section>

      {/* What counts as an AI datacenter */}
      <section aria-labelledby="definition-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § 01 · Definition
        </p>
        <h2
          id="definition-heading"
          className="font-display text-2xl text-foreground"
        >
          What counts as an &ldquo;AI datacenter&rdquo;
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Working definition: facilities primarily purpose-built or repurposed
          for large-scale AI and machine-learning training or inference,
          typically characterized by hyperscale GPU or accelerator clusters
          rather than general-purpose cloud or enterprise compute.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The category is inherently imprecise — hyperscale cloud campuses
          increasingly colocate AI workloads alongside other compute, and
          company announcements often do not distinguish between the two. Every
          record therefore carries an{" "}
          <strong className="font-medium text-foreground">
            AI classification
          </strong>{" "}
          that reflects how confident we are that a facility is primarily AI
          compute:
        </p>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium text-foreground">Confirmed</dt>
            <dd className="text-muted-foreground">
              The operator or a credible primary source explicitly describes the
              facility as an AI or GPU cluster (e.g., xAI Colossus).
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Likely</dt>
            <dd className="text-muted-foreground">
              The facility exhibits strong indicators (e.g., hyperscale GPU
              procurement, AI-specific power agreements) but has not been
              explicitly confirmed as AI-primary.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Mixed use</dt>
            <dd className="text-muted-foreground">
              A multi-purpose campus where AI workloads are a known component
              but not necessarily the primary or exclusive use.
            </dd>
          </div>
        </dl>
      </section>

      {/* Status definitions */}
      <section aria-labelledby="status-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § 02 · Status
        </p>
        <h2
          id="status-heading"
          className="font-display text-2xl text-foreground"
        >
          Status definitions
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Each facility carries one of five lifecycle statuses. Tracking status
          transitions over time is a core feature of Compute Atlas — the full
          history of known status changes is recorded for every facility.
        </p>
        <dl className="space-y-3 text-sm">
          {STATUS_ORDER.map((s) => {
            const meta = STATUS_META[s];
            return (
              <div key={s}>
                <dt className="font-medium text-foreground">{meta.label}</dt>
                <dd className="text-muted-foreground">{meta.description}</dd>
              </div>
            );
          })}
        </dl>
      </section>

      {/* Confidence levels */}
      <section aria-labelledby="confidence-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § 03 · Confidence
        </p>
        <h2
          id="confidence-heading"
          className="font-display text-2xl text-foreground"
        >
          Confidence levels
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          In addition to AI classification, each record carries a{" "}
          <strong className="font-medium text-foreground">
            confidence level
          </strong>{" "}
          that reflects the quality and independence of the underlying sources:
        </p>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium text-foreground">Confirmed</dt>
            <dd className="text-muted-foreground">
              Verified by multiple independent sources or by an official
              operator announcement with supporting documentation (e.g., permit
              filings, utility agreements).
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Reported</dt>
            <dd className="text-muted-foreground">
              Covered by at least one credible news outlet or official filing,
              but not yet corroborated by multiple independent sources.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Rumored</dt>
            <dd className="text-muted-foreground">
              Based on a single, unverified source or on indirect indicators
              (e.g., job postings, land acquisition records). Treat with caution
              and check the linked sources directly.
            </dd>
          </div>
        </dl>
      </section>

      {/* How data is compiled */}
      <section aria-labelledby="data-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § 04 · Sources
        </p>
        <h2
          id="data-heading"
          className="font-display text-2xl text-foreground"
        >
          How the data is compiled
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The current dataset is a curated seed drawn from publicly available
          sources. Every record links to the specific sources used to create or
          update it. Source types include:
        </p>
        <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
          <li>Company announcements and press releases</li>
          <li>Permit and zoning filings</li>
          <li>Utility and ISO interconnection queue entries</li>
          <li>Federal and state subsidy disclosures</li>
          <li>OpenStreetMap data (for coordinates and facility boundaries)</li>
        </ul>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The roadmap includes automated ingestion from interconnection queues
          and public permit databases, as well as a structured community
          submission process. If you have a correction or addition, see the
          Contribute section below.
        </p>
      </section>

      {/* Limitations */}
      <section aria-labelledby="limitations-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § 05 · Limitations
        </p>
        <h2
          id="limitations-heading"
          className="font-display text-2xl text-foreground"
        >
          Limitations
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Compute Atlas aims to be accurate and honest, but there are real
          constraints on what the data can reliably represent:
        </p>
        <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground">
          <li>
            There is no national registry of AI datacenters. &ldquo;AI
            datacenter&rdquo; is not a legal or regulatory category.
          </li>
          <li>
            Announcements are often aspirational. Projects are frequently
            delayed, scaled back, or cancelled after public announcements —
            tracking cancellations is a feature, not an edge case.
          </li>
          <li>
            Coverage is partial and skews toward large, well-reported
            facilities. Smaller or less-publicized projects are likely
            underrepresented.
          </li>
          <li>
            Capacity figures (in megawatts) are often estimates from
            third-party sources and may mix planned with operational capacity.
            They should be treated as approximate.
          </li>
          <li>
            Coordinates are best-effort from public sources (OpenStreetMap,
            permit filings). Some coordinates reflect a nearby town center
            rather than the facility itself.
          </li>
        </ul>
      </section>

      {/* Attribution and licenses */}
      <section aria-labelledby="attribution-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § 06 · License
        </p>
        <h2
          id="attribution-heading"
          className="font-display text-2xl text-foreground"
        >
          Attribution &amp; licenses
        </h2>
        <ul className="space-y-2 text-sm text-muted-foreground list-disc list-inside">
          <li>
            Map basemap &copy; OpenStreetMap contributors, served via{" "}
            <a
              href="https://openfreemap.org"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="OpenFreeMap map tiles (opens in new tab)"
              className="underline underline-offset-2 hover:text-foreground"
            >
              OpenFreeMap
            </a>
            , licensed under the{" "}
            <a
              href="https://opendatacommons.org/licenses/odbl/"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Open Database License (ODbL) (opens in new tab)"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Open Database License (ODbL)
            </a>
            .
          </li>
          <li>
            Where data is derived from{" "}
            <a
              href="https://epochai.org"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Epoch AI datasets (opens in new tab)"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Epoch AI
            </a>{" "}
            datasets, it is used under the{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Creative Commons Attribution 4.0 (CC-BY) license (opens in new tab)"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Creative Commons Attribution 4.0 (CC-BY)
            </a>{" "}
            license.
          </li>
          <li>
            The Compute Atlas codebase and original data are published at{" "}
            <a
              href={siteConfig.repoUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="View the Compute Atlas repository on GitHub (opens in new tab)"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {siteConfig.repoUrl}
            </a>
            .
          </li>
        </ul>
      </section>

      {/* Contribute / corrections */}
      <section aria-labelledby="contribute-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § 07 · Contribute
        </p>
        <h2
          id="contribute-heading"
          className="font-display text-2xl text-foreground"
        >
          Contribute &amp; corrections
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Community contribution is how this atlas stays accurate and grows.
          If you have a correction, a missing facility, or an updated source,
          open an issue on GitHub — every submitted change needs one thing: a
          public source URL anyone can verify.
        </p>
        <a
          href={`${siteConfig.repoUrl}/issues/new/choose`}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Open an issue on GitHub to suggest a correction or new facility (opens in new tab)"
          className="inline-flex h-11 items-center gap-2 rounded-md border border-primary bg-primary/10 px-5 font-mono text-sm font-semibold uppercase tracking-wider text-primary transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Open an issue on GitHub →
        </a>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Prefer to support the work directly?{" "}
          <a href={siteConfig.sponsorUrl} target="_blank" rel="noreferrer noopener"
             aria-label="Sponsor Compute Atlas on GitHub Sponsors (opens in new tab)"
             className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm">Sponsor this project on GitHub</a>.
        </p>
      </section>

      {/* Back navigation */}
      <div className="pt-4 border-t border-border">
        <Link
          href="/map"
          className="inline-flex items-center text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
        >
          ← Back to the map
        </Link>
      </div>
    </div>
  );
}
