import Link from "next/link";
import type { Metadata } from "next";

import { getAiClassificationByState, getAiClassificationCounts } from "@/lib/data";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";
import { Breadcrumb } from "@/components/breadcrumb";
import { breadcrumbJsonLdString, itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";
import { aiClassificationEnum } from "@/lib/schema";

export const revalidate = 3600;

type AiClassification = (typeof aiClassificationEnum.options)[number];

/** Display labels for AI classification enum keys — mirrors app/stats/page.tsx. */
const AI_CLASSIFICATION_LABELS: Record<AiClassification, string> = {
  confirmed: "Confirmed",
  likely: "Likely",
  mixed_use: "Mixed use",
};

const AI_CLASSIFICATION_ORDER = aiClassificationEnum.options;

/** Joins non-zero classification counts into a compact inline summary, e.g. "3 confirmed · 1 likely". */
function formatStateCounts(counts: Record<AiClassification, number>): string {
  return AI_CLASSIFICATION_ORDER.filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${AI_CLASSIFICATION_LABELS[k].toLowerCase()}`)
    .join(" · ");
}

const CRUMBS = [{ label: "Explore", href: "/explore" }, { label: "AI" }];

export const metadata: Metadata = {
  title: "AI data centers by state",
  description:
    "Which U.S. states host the most AI-classified data centers — confirmed AI/GPU clusters, likely AI-primary sites, and mixed-use campuses — grouped by state. Source-cited.",
  alternates: { canonical: "/ai" },
};

/**
 * /ai — index of AI-classified data centers, grouped by state. Static server
 * component targeting the state-joined long tail ("AI data centers by
 * state") rather than the contested bare "AI data center map" head term.
 * Mirrors the /crypto and /power visual language (masthead, survey-stat row,
 * classification explainer, block-Link state list).
 */
export default async function AiPage() {
  const [aiCounts, statesData] = await Promise.all([
    getAiClassificationCounts(),
    getAiClassificationByState(),
  ]);

  const totalAiClassified =
    aiCounts.confirmed + aiCounts.likely + aiCounts.mixed_use;

  const stateRows = statesData.map(({ state, counts }) => ({
    code: state,
    name: stateNameFromCode(state) ?? state,
    slug: stateSlugFromCode(state),
    counts,
    total: counts.confirmed + counts.likely + counts.mixed_use,
  }));

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
            stateRows
              .filter((s) => s.slug)
              .map((s) => ({
                name: s.name,
                url: `${siteConfig.url}/states/${s.slug}`,
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
          AI classification
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          AI data centers by state
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Where AI/GPU compute is concentrated across the tracked data-center
          layer, state by state.
        </p>
        <div className="border-t border-border" />
      </header>

      {totalAiClassified === 0 ? (
        <p className="text-base text-muted-foreground">
          No AI-classified data centers are tracked yet.
        </p>
      ) : (
        <>
          {/* ------------------------------------------------------------------ */}
          {/* Overview prose + classification explainer                          */}
          {/* ------------------------------------------------------------------ */}
          <div className="max-w-2xl space-y-4">
            <p className="text-base leading-relaxed text-muted-foreground">
              Compute Atlas flags data-center records with a discernible AI or
              machine-learning angle, distinguishing them from traditional
              enterprise and general-purpose facilities. {totalAiClassified}{" "}
              data {totalAiClassified === 1 ? "center carries" : "centers carry"}{" "}
              an AI classification today, across {stateRows.length}{" "}
              {stateRows.length === 1 ? "state" : "states"}.
            </p>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-medium text-foreground">Confirmed</dt>
                <dd className="text-muted-foreground">
                  The operator or a credible primary source explicitly
                  describes the facility as an AI or GPU cluster.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Likely</dt>
                <dd className="text-muted-foreground">
                  The facility exhibits strong indicators — hyperscale GPU
                  procurement, AI-specific power agreements — but has not been
                  explicitly confirmed as AI-primary.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Mixed use</dt>
                <dd className="text-muted-foreground">
                  A multi-purpose campus where AI workloads are a known
                  component but not necessarily the primary or exclusive use.
                </dd>
              </div>
            </dl>
            <p className="text-base leading-relaxed text-muted-foreground">
              Not every data center has a classification — general-purpose
              facilities with no discernible AI angle carry none, which is
              itself meaningful information, not a gap in the data. Each
              record below links through to its full facility list and cited
              sources.
            </p>
          </div>

          {/* ------------------------------------------------------------------ */}
          {/* Survey stats row                                                    */}
          {/* ------------------------------------------------------------------ */}
          <div className="flex flex-wrap gap-8 border-b border-border pb-10">
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {totalAiClassified}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                AI-classified
              </span>
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {aiCounts.confirmed}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Confirmed
              </span>
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {aiCounts.likely}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Likely
              </span>
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {stateRows.length}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                States
              </span>
            </div>
          </div>

          {/* ------------------------------------------------------------------ */}
          {/* § States                                                            */}
          {/* ------------------------------------------------------------------ */}
          <section
            aria-labelledby="states-heading"
            className="space-y-4 border-t border-border pt-10"
          >
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              § States
            </p>
            <h2 id="states-heading" className="font-display text-2xl text-foreground">
              AI data centers by state
            </h2>
            <ul className="divide-y divide-border">
              {stateRows.map((s) => (
                <li key={s.code}>
                  {s.slug ? (
                    <Link
                      href={`/states/${s.slug}`}
                      className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                    >
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm text-foreground truncate">
                          {s.name}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          {formatStateCounts(s.counts)}
                        </span>
                      </span>
                      <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                        {s.total}
                      </span>
                    </Link>
                  ) : (
                    <div className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm text-foreground truncate">
                          {s.name}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          {formatStateCounts(s.counts)}
                        </span>
                      </span>
                      <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                        {s.total}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
