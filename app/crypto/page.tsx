import type { Metadata } from "next";

import Link from "next/link";

import {
  getCryptoMiningFacilities,
  getCryptoMiningStats,
  isUnverifiedMegaproject,
} from "@/lib/data";
import {
  formatLocation,
  formatPower,
  getFacilityMaxMw,
  sortByMaxMwDesc,
  countDisclosedCapacity,
} from "@/lib/format";
import { operatorSlug } from "@/lib/operator-slug";
import type { Facility } from "@/lib/schema";
import { STATUS_META, STATUS_ORDER } from "@/lib/status";
import {
  statesStat,
  statesPhrase,
  stateNameFromCode,
  stateSlugFromCode,
} from "@/lib/us-states";
import { Breadcrumb } from "@/components/breadcrumb";
import { CollectionJsonLd } from "@/components/collection/collection-json-ld";
import { FacilityListRow } from "@/components/facility-list-row";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { SectionHeading } from "@/components/section-heading";

export const revalidate = 86400;

const CRUMBS = [{ label: "Explore", href: "/explore" }, { label: "Crypto" }];

export const metadata: Metadata = {
  title: "Bitcoin & crypto mining facilities in the US",
  description:
    "The U.S. Bitcoin and crypto mining sites Compute Atlas tracks, by state and operator: capacity, location and build status, each record source-cited.",
  alternates: { canonical: "/crypto" },
};

/**
 * /crypto — index of the crypto_mining facility layer. Static server component.
 *
 * Surfaces crypto-mining sites (ASIC/GPU compute run to validate blockchain
 * transactions) as their own tracked layer, distinct from the AI/cloud
 * data-center facilities tracked elsewhere on the site. Mirrors the /power
 * and /opposition visual language (masthead, survey-stat row, block-Link
 * facility list), with three computed summaries ahead of the full list:
 * largest sites, a by-state table (status counts as its lead-in) and the top
 * operators. Every figure derives from the facility records.
 */

const TOP_N = 10;

interface StateRow {
  code: string;
  sites: number;
  operationalMw: number;
  plannedMw: number;
}

interface OperatorRow {
  name: string;
  sites: number;
  mw: number;
  states: string[];
}

/** Top sites by max MW: drops cancelled, undisclosed and unverified megaprojects. */
function largestSites(facilities: Facility[]): Facility[] {
  return facilities
    .filter(
      (f) =>
        f.status !== "cancelled" &&
        (getFacilityMaxMw(f) ?? 0) > 0 &&
        !isUnverifiedMegaproject(f),
    )
    .sort(sortByMaxMwDesc)
    .slice(0, TOP_N);
}

/** Sites counts every record; MW sums skip cancelled ones (as getCryptoMiningStats does). */
function stateRows(facilities: Facility[]): StateRow[] {
  const byCode = new Map<string, StateRow>();
  for (const f of facilities) {
    const code = f.location.state;
    const row = byCode.get(code) ?? { code, sites: 0, operationalMw: 0, plannedMw: 0 };
    row.sites += 1;
    if (f.status !== "cancelled") {
      row.operationalMw += f.capacityMw?.operational ?? 0;
      row.plannedMw += f.capacityMw?.planned ?? 0;
    }
    byCode.set(code, row);
  }
  const label = (code: string) => stateNameFromCode(code) ?? code;
  return [...byCode.values()].sort(
    (a, b) =>
      b.sites - a.sites ||
      b.operationalMw - a.operationalMw ||
      label(a.code).localeCompare(label(b.code)),
  );
}

function operatorRows(facilities: Facility[]): OperatorRow[] {
  const byName = new Map<string, OperatorRow>();
  for (const f of facilities) {
    const row = byName.get(f.operator) ?? { name: f.operator, sites: 0, mw: 0, states: [] };
    row.sites += 1;
    if (f.status !== "cancelled") {
      row.mw += (f.capacityMw?.operational ?? 0) + (f.capacityMw?.planned ?? 0);
    }
    if (!row.states.includes(f.location.state)) row.states.push(f.location.state);
    byName.set(f.operator, row);
  }
  return [...byName.values()]
    .map((r) => ({ ...r, states: [...r.states].sort() }))
    .sort((a, b) => b.sites - a.sites || b.mw - a.mw || a.name.localeCompare(b.name))
    .slice(0, TOP_N);
}

const mwCell = (mw: number) => (mw > 0 ? formatPower(mw) : "\u2014");
export default async function CryptoPage() {
  const [stats, facilities] = await Promise.all([
    getCryptoMiningStats(),
    getCryptoMiningFacilities(),
  ]);
  const allFacilities = [...facilities].sort(sortByMaxMwDesc);
  const disclosedCapacityCount = countDisclosedCapacity(allFacilities);
  const statesTile = statesStat(stats.stateCodes);
  const largest = largestSites(allFacilities);
  const stateTable = stateRows(allFacilities);
  const operators = operatorRows(allFacilities);
  const statusCounts = STATUS_ORDER.map((s) => ({
    status: s,
    count: allFacilities.filter((f) => f.status === s).length,
  })).filter((c) => c.count > 0);

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <CollectionJsonLd crumbs={CRUMBS} facilities={allFacilities} />

      <Breadcrumb items={CRUMBS} />

      <PageMasthead
        eyebrow="Facility type"
        title="Bitcoin and crypto mining facilities in the United States"
        dek="Bitcoin and altcoin mining capacity, tracked site by site."
      />

      {stats.count === 0 ? (
        <p className="text-base text-muted-foreground">
          No crypto-mining facilities are tracked yet.
        </p>
      ) : (
        <>
          <div className="max-w-2xl space-y-4">
            <p className="text-base leading-relaxed text-muted-foreground">
              Compute Atlas tracks {stats.count} crypto-mining
              {stats.count === 1 ? " facility" : " facilities"} — sites
              running dedicated compute hardware (ASIC or GPU rigs) to
              validate blockchain transactions, kept as their own layer
              distinct from the AI/cloud data centers tracked elsewhere on
              this site. {formatPower(stats.operationalMw)} of that capacity
              is already operational, with {formatPower(stats.plannedMw)}{" "}
              more in the pipeline, across{" "}
              {statesPhrase(stats.stateCodes)}.
            </p>
            <p className="text-base leading-relaxed text-muted-foreground">
              The facilities below are the crypto-mining sites in Compute
              Atlas&apos;s own sourced dataset — each entry links through to
              its full record and cited sources. The by-state table lists
              every state with a tracked site; the by-operator table shows
              the ten operators with the most sites.
            </p>
          </div>

          <SurveyStatRow
            stats={[
              { value: stats.count, label: "Facilities" },
              { value: formatPower(stats.operationalMw), label: "Operational" },
              { value: formatPower(stats.plannedMw), label: "Pipeline" },
              { ...statesTile },
            ]}
          />

          <p className="text-sm leading-relaxed text-muted-foreground">
            Capacity is disclosed for {disclosedCapacityCount.toLocaleString("en-US")}{" "}
            of the {stats.count.toLocaleString("en-US")} tracked crypto-mining
            sites. The operational and pipeline figures above sum those
            records only — read them as a floor, not a total across every
            tracked site.
          </p>

          {largest.length > 0 && (
            <section
              aria-labelledby="largest-heading"
              className="space-y-4 border-t border-border pt-10"
            >
              <SectionHeading kicker="Largest" id="largest-heading" title="Largest sites" />
              <p className="text-sm text-muted-foreground">
                Ranked by the larger of operational and planned capacity.
                Cancelled sites, sites with no disclosed capacity and
                unverified multi-gigawatt claims are left out.
              </p>
              <ul className="divide-y divide-border">
                {largest.map((f) => (
                  <li key={f.id}>
                    <FacilityListRow
                      facility={f}
                      secondary={
                        <>
                          {f.operator} &middot; {formatLocation(f)} &middot;{" "}
                          {formatPower(getFacilityMaxMw(f) ?? 0)}
                        </>
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section
            aria-labelledby="by-state-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <SectionHeading kicker="Geography" id="by-state-heading" title="By state" />
            <p className="text-sm text-muted-foreground">
              {statusCounts
                .map((c) => `${c.count.toLocaleString("en-US")} ${STATUS_META[c.status].label.toLowerCase()}`)
                .join(" \u00b7 ")}
              . Sites counts every tracked record, cancelled included;
              capacity sums skip cancelled sites.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Crypto-mining sites and disclosed capacity by state
                </caption>
                <thead>
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="py-2 pr-4 font-medium">State</th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">Sites</th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">Operational</th>
                    <th scope="col" className="py-2 text-right font-medium">Pipeline</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {stateTable.map((r) => {
                    const slug = stateSlugFromCode(r.code);
                    const name = stateNameFromCode(r.code) ?? r.code;
                    return (
                      <tr key={r.code}>
                        <th scope="row" className="py-2 pr-4 text-left font-normal">
                          {slug ? (
                            <Link href={`/states/${slug}`} className="inline-flex min-h-11 items-center rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                              {name}
                            </Link>
                          ) : (
                            name
                          )}
                        </th>
                        <td className="py-2 pr-4 text-right tabular-nums">{r.sites}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{mwCell(r.operationalMw)}</td>
                        <td className="py-2 text-right tabular-nums">{mwCell(r.plannedMw)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section
            aria-labelledby="by-operator-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <SectionHeading kicker="Operators" id="by-operator-heading" title="By operator" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Operators with the most tracked crypto-mining sites
                </caption>
                <thead>
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="py-2 pr-4 font-medium">Operator</th>
                    <th scope="col" className="py-2 pr-4 text-right font-medium">Sites</th>
                    <th scope="col" className="py-2 font-medium">States</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {operators.map((o) => (
                    <tr key={o.name}>
                      <th scope="row" className="py-2 pr-4 text-left font-normal">
                        <Link href={`/operators/${operatorSlug(o.name)}`} className="inline-flex min-h-11 items-center rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                          {o.name}
                        </Link>
                      </th>
                      <td className="py-2 pr-4 text-right tabular-nums">{o.sites}</td>
                      <td className="py-2">{o.states.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

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
