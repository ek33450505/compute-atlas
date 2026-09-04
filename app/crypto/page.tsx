import type { Metadata } from "next";

import { getCryptoMiningFacilities, getCryptoMiningStats } from "@/lib/data";
import { formatLocation, formatPower, sortByMaxMwDesc, countDisclosedCapacity } from "@/lib/format";
import { Breadcrumb } from "@/components/breadcrumb";
import { CollectionJsonLd } from "@/components/collection/collection-json-ld";
import { FacilityListRow } from "@/components/facility-list-row";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { SectionHeading } from "@/components/section-heading";

export const revalidate = 3600;

const CRUMBS = [{ label: "Explore", href: "/explore" }, { label: "Crypto" }];

export const metadata: Metadata = {
  title: "Crypto mining facilities",
  description:
    "The U.S. crypto (Bitcoin and altcoin) mining sites Compute Atlas tracks — capacity, location, and build status, each record source-cited.",
  alternates: { canonical: "/crypto" },
};

/**
 * /crypto — index of the crypto_mining facility layer. Static server component.
 *
 * Surfaces crypto-mining sites (ASIC/GPU compute run to validate blockchain
 * transactions) as their own tracked layer, distinct from the AI/cloud
 * data-center facilities tracked elsewhere on the site. Mirrors the /power
 * and /opposition visual language (masthead, survey-stat row, block-Link
 * facility list).
 */
export default async function CryptoPage() {
  const [stats, facilities] = await Promise.all([
    getCryptoMiningStats(),
    getCryptoMiningFacilities(),
  ]);
  const allFacilities = [...facilities].sort(sortByMaxMwDesc);
  const disclosedCapacityCount = countDisclosedCapacity(allFacilities);

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <CollectionJsonLd crumbs={CRUMBS} facilities={allFacilities} />

      <Breadcrumb items={CRUMBS} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <PageMasthead
        eyebrow="Crypto mining"
        title="Crypto mining facilities in the United States"
        dek="Bitcoin and altcoin mining capacity, tracked site by site."
      />

      {stats.count === 0 ? (
        <p className="text-base text-muted-foreground">
          No crypto-mining facilities are tracked yet.
        </p>
      ) : (
        <>
          {/* ------------------------------------------------------------------ */}
          {/* Overview prose                                                      */}
          {/* ------------------------------------------------------------------ */}
          <div className="max-w-2xl space-y-4">
            <p className="text-base leading-relaxed text-muted-foreground">
              Compute Atlas tracks {stats.count} crypto-mining
              {stats.count === 1 ? " facility" : " facilities"} — sites
              running dedicated compute hardware (ASIC or GPU rigs) to
              validate blockchain transactions, kept as their own layer
              distinct from the AI/cloud data centers tracked elsewhere on
              this site. {formatPower(stats.operationalMw)} of that capacity
              is already operational, with {formatPower(stats.plannedMw)}{" "}
              more in the pipeline, across {stats.stateCount}{" "}
              {stats.stateCount === 1 ? "state" : "states"}.
            </p>
            <p className="text-base leading-relaxed text-muted-foreground">
              The facilities below are the crypto-mining sites in Compute
              Atlas&apos;s own sourced dataset — each entry links through to
              its full record and cited sources.
            </p>
          </div>

          {/* ------------------------------------------------------------------ */}
          {/* Survey stats row                                                    */}
          {/* ------------------------------------------------------------------ */}
          <SurveyStatRow
            stats={[
              { value: stats.count, label: "Facilities" },
              { value: formatPower(stats.operationalMw), label: "Operational" },
              { value: formatPower(stats.plannedMw), label: "Pipeline" },
              { value: stats.stateCount, label: "States" },
            ]}
          />

          <p className="text-sm leading-relaxed text-muted-foreground">
            Capacity is disclosed for {disclosedCapacityCount.toLocaleString("en-US")}{" "}
            of the {stats.count.toLocaleString("en-US")} tracked crypto-mining
            sites. The operational and pipeline figures above sum those
            records only — read them as a floor, not a total across every
            tracked site.
          </p>

          {/* ------------------------------------------------------------------ */}
          {/* § Facilities                                                        */}
          {/* ------------------------------------------------------------------ */}
          <section
            aria-labelledby="facilities-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <SectionHeading kicker="Facilities" id="facilities-heading" title="All crypto-mining facilities" />
            <ul className="divide-y divide-border">
              {allFacilities.map((f) => (
                <li key={f.id}>
                  <FacilityListRow
                    facility={f}
                    secondary={<>{f.operator} &middot; {formatLocation(f)}</>}
                  />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
