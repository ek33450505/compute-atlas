import type { Metadata } from "next";
import Link from "next/link";

import { STATUS_META, STATUS_ORDER } from "@/lib/status";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META } from "@/lib/facility-type";
import { COMMUNITY_RECEPTION_ORDER, COMMUNITY_RECEPTION_META } from "@/lib/community";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "How Compute Atlas is compiled — the sourcing standard, facility types, confidence tiers, community-reception scale, and the honest-zero convention behind every record.",
};

export default function MethodologyPage() {
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
            How the atlas is built · Edition 2026
          </p>
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
            Methodology &amp; data dictionary.
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
            Every field in this dataset traces back to a public source, cited
            on the facility&rsquo;s page — this page defines the categories,
            tiers, and conventions used to record it.
          </p>
        </div>
        <div className="border-t border-border" />
      </header>

      {/* What we track */}
      <section aria-labelledby="definition-heading" className="space-y-4">
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
