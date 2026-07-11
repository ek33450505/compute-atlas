import type { Metadata } from "next";
import Link from "next/link";

import { siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: "About",
  description:
    "Why Compute Atlas exists — a community-driven, source-cited survey of U.S. grid-scale compute infrastructure, open to correction by anyone with a public source.",
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
            About · Edition 2026
          </p>
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
            Public, but scattered.
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
            Compute Atlas is an open, source-cited survey of the grid-scale
            compute buildout across the United States — where it&rsquo;s being
            built, by whom, and at what cost to energy, water, and the
            communities nearby.
          </p>
        </div>
        <div className="border-t border-border" />
      </header>

      {/* ---- About ---- */}
      <section aria-labelledby="about-method-heading" className="space-y-8">
        <h2 id="about-method-heading" className="sr-only">
          About
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
            genuinely difficult work. That&rsquo;s the gap this atlas tries to
            close.
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

        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            For facility-type definitions, confidence tiers, the
            community-reception scale, and the full data dictionary, see the{" "}
            <Link
              href="/methodology"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Methodology
            </Link>{" "}
            page.
          </p>
        </div>
      </section>

      {/* Attribution and licenses */}
      <section aria-labelledby="attribution-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § 01 · License
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
          § 02 · Contribute
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
