import Link from "next/link";
import type { Metadata } from "next";

import { getCryptoMiningFacilities, getCryptoMiningStats } from "@/lib/data";
import { formatCapacity, formatLocation, formatPower, getFacilityMaxMw } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb } from "@/components/breadcrumb";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { breadcrumbJsonLdString, itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";

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
  const allFacilities = [...facilities].sort(
    (a, b) =>
      (getFacilityMaxMw(b) ?? -1) - (getFacilityMaxMw(a) ?? -1) ||
      a.name.localeCompare(b.name)
  );

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbJsonLdString(
            CRUMBS.map((c) => ({ name: c.label, url: c.href }))
          ),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: itemListJsonLdString(
            allFacilities.map((f) => ({
              name: f.name,
              url: `${siteConfig.url}/facilities/${f.id}`,
            }))
          ),
        }}
      />

      <Breadcrumb items={CRUMBS} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <header className="space-y-4 pb-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          Crypto mining
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          Crypto mining facilities in the United States
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Bitcoin and altcoin mining capacity, tracked site by site.
        </p>
        <div className="border-t border-border" />
      </header>

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

          {/* ------------------------------------------------------------------ */}
          {/* § Facilities                                                        */}
          {/* ------------------------------------------------------------------ */}
          <section
            aria-labelledby="facilities-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              § Facilities
            </p>
            <h2 id="facilities-heading" className="font-display text-2xl text-foreground">
              All crypto-mining facilities
            </h2>
            <ul className="divide-y divide-border">
              {allFacilities.map((f) => (
                <li key={f.id}>
                  <Link
                    href={`/facilities/${f.id}`}
                    className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                  >
                    <span className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm text-foreground truncate">
                        {f.name}
                      </span>
                      <span className="text-xs text-muted-foreground truncate">
                        {f.operator} &middot; {formatLocation(f)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <StatusBadge status={f.status} />
                      <span className="font-mono tabular-nums text-xs text-muted-foreground">
                        {formatCapacity(f)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
