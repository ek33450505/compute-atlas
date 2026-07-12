import type { Metadata } from "next";

import { siteConfig } from "@/lib/site";
import { STATUS_META, STATUS_ORDER } from "@/lib/status";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META } from "@/lib/facility-type";
import { COMMUNITY_RECEPTION_ORDER, COMMUNITY_RECEPTION_META } from "@/lib/community";
import { Breadcrumb } from "@/components/breadcrumb";

export const metadata: Metadata = {
  title: "About & method",
  description:
    "Why Compute Atlas exists and how it's compiled — the sourcing standard, facility types, confidence tiers, community-reception scale, and the honest-zero convention behind every record.",
};

export default function AboutPage() {
  return (
    <div data-content-width="3xl" className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16 space-y-12">
      <Breadcrumb items={[{ label: "Map", href: "/map" }, { label: "About" }]} />
      {/* ---- Masthead ---- */}
      <header className="relative">
        <div
          aria-hidden="true"
          className="graticule pointer-events-none absolute inset-0 opacity-40 [mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]"
        />
        <div className="relative space-y-4 pb-8">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            About &amp; method · Edition 2026
          </p>
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
            Public, but scattered.
          </h1>
          <p className="drop-cap max-w-2xl text-base leading-relaxed text-muted-foreground">
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
          About &amp; method
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
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              The source code and data are public.
            </a>
          </p>
        </div>
      </section>

      {/* What we track */}
      <section aria-labelledby="definition-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § What we track
        </p>
        <h2
          id="definition-heading"
          className="font-display text-2xl text-foreground"
        >
          What we track
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Working definition: physical, source-cited facilities that consume
          or feed grid-scale power for compute — traditional and enterprise
          data centers, hyperscale/AI-specific compute campuses, large-scale
          crypto-mining operations, and the dedicated power generation built
          or contracted to supply them. Every record carries a facility type:
        </p>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium text-foreground">
              {FACILITY_TYPE_META[FACILITY_TYPE_ORDER[0]].label}
            </dt>
            <dd className="text-muted-foreground">
              Enterprise, hyperscale, and AI-specific compute campuses on
              grid-scale power.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">
              {FACILITY_TYPE_META[FACILITY_TYPE_ORDER[1]].label}
            </dt>
            <dd className="text-muted-foreground">
              Large-scale mining operations, which draw on the same grid
              capacity as data centers.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">
              {FACILITY_TYPE_META[FACILITY_TYPE_ORDER[2]].label}
            </dt>
            <dd className="text-muted-foreground">
              Dedicated generation — e.g. nuclear or small modular reactors —
              built or contracted specifically to feed the compute buildout.
              Tracked as its own layer, distinct from the compute campuses it
              supplies.
            </dd>
          </div>
        </dl>
      </section>

      {/* AI classification */}
      <section aria-labelledby="ai-classification-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § AI classification
        </p>
        <h2
          id="ai-classification-heading"
          className="font-display text-2xl text-foreground"
        >
          AI classification
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          For data-center records with a discernible AI or machine-learning
          angle, an additional{" "}
          <strong className="font-medium text-foreground">
            AI classification
          </strong>{" "}
          reflects how confident we are that AI/ML compute is a primary use.
          Not every data center has one — general-purpose and enterprise
          facilities with no AI angle carry no classification at all, which is
          itself meaningful information, not a gap in the data:
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

      {/* Build status */}
      <section aria-labelledby="status-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Build status
        </p>
        <h2
          id="status-heading"
          className="font-display text-2xl text-foreground"
        >
          Build status
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

      {/* Confidence */}
      <section aria-labelledby="confidence-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Confidence
        </p>
        <h2
          id="confidence-heading"
          className="font-display text-2xl text-foreground"
        >
          Confidence
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

      {/* Community reception */}
      <section aria-labelledby="community-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Community reception
        </p>
        <h2
          id="community-heading"
          className="font-display text-2xl text-foreground"
        >
          Community reception
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Each record may carry a{" "}
          <strong className="font-medium text-foreground">
            community reception
          </strong>{" "}
          tier — a sourced signal of how the facility has been received
          locally, not an editorial judgment:
        </p>
        <dl className="space-y-3 text-sm">
          {COMMUNITY_RECEPTION_ORDER.map((r) => (
            <div key={r}>
              <dt className="font-medium text-foreground">
                {COMMUNITY_RECEPTION_META[r].label}
              </dt>
              <dd className="text-muted-foreground">
                {r === "supported" &&
                  "Local officials or residents have expressed public support, with no documented opposition."}
                {r === "mixed" &&
                  "Documented support and opposition both exist, with no clear majority position on record."}
                {r === "contested" &&
                  "Active public debate — hearings, petitions, or organized opposition — without litigation."}
                {r === "opposed" &&
                  "Documented, organized local opposition is the dominant sourced signal."}
                {r === "litigation" &&
                  "The facility is or has been the subject of a lawsuit related to its siting, permitting, or operation."}
                {r === "unknown" &&
                  "Reception was looked for and none is documented — a sourced value in its own right, distinct from a record that carries no community data at all."}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* The honest-zero convention */}
      <section aria-labelledby="honest-zero-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § The honest-zero convention
        </p>
        <h2
          id="honest-zero-heading"
          className="font-display text-2xl text-foreground"
        >
          The honest-zero convention
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This is the project&rsquo;s core data-integrity principle: the atlas
          records &ldquo;unknown&rdquo; or omits a field entirely rather than
          guessing. Ranges, projections, and estimates are recorded as notes,
          never presented as fact. An omitted numeric field means the figure
          is{" "}
          <strong className="font-medium text-foreground">not known</strong>{" "}
          — it does not mean zero.
        </p>
      </section>

      {/* Sources */}
      <section aria-labelledby="sources-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Sources
        </p>
        <h2
          id="sources-heading"
          className="font-display text-2xl text-foreground"
        >
          Sources
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
          submission process.
        </p>
      </section>

      {/* Location precision */}
      <section aria-labelledby="precision-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Location precision
        </p>
        <h2
          id="precision-heading"
          className="font-display text-2xl text-foreground"
        >
          Location precision
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Every record carries a location precision tier, reflecting how
          closely the plotted coordinates match the facility&rsquo;s real
          footprint:
        </p>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium text-foreground">Exact</dt>
            <dd className="text-muted-foreground">
              Lat/lon is the facility&rsquo;s real footprint. The default —
              every record without an explicit precision value is exact.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Approximate</dt>
            <dd className="text-muted-foreground">
              A best-effort geocode, e.g. from a street address, not
              parcel-confirmed.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">
              Representative (multi-site)
            </dt>
            <dd className="text-muted-foreground">
              The facility is a distributed fleet with no single fixed
              location — the plotted point is illustrative only.
            </dd>
          </div>
        </dl>
      </section>

      {/* Limitations */}
      <section aria-labelledby="limitations-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Limitations
        </p>
        <h2
          id="limitations-heading"
          className="font-display text-2xl text-foreground"
        >
          Limitations
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          There are real constraints on what this data can reliably represent,
          and it&rsquo;s better to name them plainly:
        </p>
        <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground">
          <li>
            There is no national registry of data centers. &ldquo;Data
            center&rdquo; spans a wide range of facility types with no single
            legal or regulatory definition.
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
          § Attribution
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
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              OpenFreeMap
            </a>
            , licensed under the{" "}
            <a
              href="https://opendatacommons.org/licenses/odbl/"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Open Database License (ODbL) (opens in new tab)"
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
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
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              Epoch AI
            </a>{" "}
            datasets, it is used under the{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Creative Commons Attribution 4.0 (CC-BY) license (opens in new tab)"
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
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
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
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
          § Contribute
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
    </div>
  );
}
