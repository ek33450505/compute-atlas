import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { GLOSSARY_TOPICS, getGlossaryTopicBySlug } from "@/lib/glossary";
import {
  getWaterUsage,
  getCoolingTypeCounts,
  getStats,
  getFacilityTypeCounts,
  getEnergySourceCounts,
  getAiClassificationCounts,
  getGenerationStats,
  getCommunityReceptionCounts,
  getFacilitiesByIds,
} from "@/lib/data";
import { formatMgd, formatPower } from "@/lib/format";
import { ENERGY_SOURCE_ENTRIES, COOLING_TYPE_ENTRIES } from "@/lib/energy";
import { COMMUNITY_RECEPTION_ORDER, COMMUNITY_RECEPTION_META } from "@/lib/community";
import { Breadcrumb } from "@/components/breadcrumb";
import { Explainer } from "@/components/learn/explainer";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { breadcrumbJsonLdString } from "@/lib/seo";

export const revalidate = 3600;

interface StatCell {
  value: string;
  label: string;
}

interface BreakdownRow {
  label: string;
  count: number;
  pct: number;
}

interface TopicContent {
  /** One factual, dataset-grounded explainer paragraph — never fabricated. */
  explainer: string;
  /** The topic's real stat block (survey-stat row). */
  stats: StatCell[];
  /** Optional secondary progress-bar breakdown (cooling type / energy source / reception). */
  breakdown?: BreakdownRow[];
  breakdownLabel?: string;
  /** Optional cross-link into the fuller hub page for this topic. */
  crossLink?: { href: string; label: string };
}

/**
 * Maps a glossary slug to its dataset-grounded content: the helper(s) named
 * in the task spec (getWaterUsage/getCoolingTypeCounts, getStats/
 * getEnergySourceCounts, getAiClassificationCounts, getGenerationStats,
 * getCommunityReceptionCounts) feed the explainer sentence and stat block —
 * nothing here is invented or estimated.
 */
async function getTopicContent(slug: string): Promise<TopicContent | undefined> {
  switch (slug) {
    case "data-center-water-use": {
      const [{ reportingCount, totalMgd }, coolingCounts] = await Promise.all([
        getWaterUsage(),
        getCoolingTypeCounts(),
      ]);
      const coolingRows = COOLING_TYPE_ENTRIES.filter(({ key }) => coolingCounts[key] > 0);
      const coolingReporting = coolingRows.reduce((sum, { key }) => sum + coolingCounts[key], 0);
      return {
        explainer:
          reportingCount > 0
            ? `Compute Atlas tracks ${reportingCount} facilit${reportingCount === 1 ? "y that discloses" : "ies that disclose"} a daily water figure, totaling ${formatMgd(totalMgd)} across the dataset — a reported floor, not a dataset total, since most facilities don't publish this number.`
            : "No tracked facility discloses a daily water figure yet — this would be a reported floor, not a dataset total, since most facilities don't publish this number.",
        stats: [
          { value: String(reportingCount), label: "Facilities reporting" },
          { value: formatMgd(totalMgd), label: "Total reported" },
        ],
        breakdown: coolingRows.map(({ key, label }) => ({
          label,
          count: coolingCounts[key],
          pct: coolingReporting > 0 ? (coolingCounts[key] / coolingReporting) * 100 : 0,
        })),
        breakdownLabel: "Cooling method",
      };
    }
    case "data-center-power-draw": {
      const [stats, typeCounts, energyCounts] = await Promise.all([
        getStats(),
        getFacilityTypeCounts(),
        getEnergySourceCounts(),
      ]);
      const energyRows = ENERGY_SOURCE_ENTRIES.filter(({ key }) => energyCounts[key] > 0);
      const energyReporting = energyRows.reduce((sum, { key }) => sum + energyCounts[key], 0);
      return {
        explainer: `Compute Atlas tracks ${typeCounts.data_center} data centers across ${stats.states} states, alongside ${typeCounts.crypto_mining} crypto-mining sites and ${typeCounts.power_generation} dedicated generation projects, with ${formatPower(stats.operationalMw)} of operational capacity today and ${formatPower(stats.plannedMw)} planned or under construction.`,
        stats: [
          { value: formatPower(stats.operationalMw), label: "Operational" },
          { value: formatPower(stats.plannedMw), label: "Planned pipeline" },
          { value: formatPower(stats.underConstructionMw), label: "Under construction" },
        ],
        breakdown: energyRows.map(({ key, label }) => ({
          label,
          count: energyCounts[key],
          pct: energyReporting > 0 ? (energyCounts[key] / energyReporting) * 100 : 0,
        })),
        breakdownLabel: "Power source, all tracked facilities",
      };
    }
    case "what-is-an-ai-data-center": {
      const aiCounts = await getAiClassificationCounts();
      const total = aiCounts.confirmed + aiCounts.likely + aiCounts.mixed_use;
      return {
        explainer:
          total > 0
            ? `${total} tracked data center${total === 1 ? " carries" : "s carry"} an AI classification today — confirmed, likely, or mixed use — out of the facilities in Compute Atlas's dataset.`
            : "No tracked data center carries an AI classification yet.",
        stats: [
          { value: String(aiCounts.confirmed), label: "Confirmed" },
          { value: String(aiCounts.likely), label: "Likely" },
          { value: String(aiCounts.mixed_use), label: "Mixed use" },
        ],
        crossLink: { href: "/ai", label: "the AI data center hub" },
      };
    }
    case "behind-the-meter-power": {
      const genStats = await getGenerationStats();
      return {
        explainer:
          genStats.count > 0
            ? `Compute Atlas tracks ${genStats.count} dedicated power-generation project${genStats.count === 1 ? "" : "s"} built specifically to power a data center behind the meter, with ${formatPower(genStats.operationalMw)} operational and ${formatPower(genStats.plannedMw)} more planned, contracted across ${genStats.offtakerCount} offtaker${genStats.offtakerCount === 1 ? "" : "s"}.`
            : "No dedicated power-generation projects are tracked yet.",
        stats: [
          { value: String(genStats.count), label: "Projects" },
          { value: formatPower(genStats.operationalMw), label: "Operational" },
          { value: formatPower(genStats.plannedMw), label: "Planned" },
          { value: String(genStats.offtakerCount), label: "Offtakers" },
        ],
        crossLink: { href: "/power", label: "the power generation hub" },
      };
    }
    case "why-do-communities-oppose-data-centers": {
      const commCounts = await getCommunityReceptionCounts();
      const reporting = COMMUNITY_RECEPTION_ORDER.reduce((sum, k) => sum + commCounts[k], 0);
      const friction = commCounts.contested + commCounts.opposed + commCounts.litigation;
      const receptionRows = COMMUNITY_RECEPTION_ORDER.filter((k) => commCounts[k] > 0).map(
        (k) => ({
          label: COMMUNITY_RECEPTION_META[k].label,
          count: commCounts[k],
          pct: reporting > 0 ? (commCounts[k] / reporting) * 100 : 0,
        })
      );
      return {
        explainer:
          reporting > 0
            ? `Of the ${reporting} tracked facilities with a sourced community-reception status, ${friction} face${friction === 1 ? "s" : ""} documented friction — contested, opposed, or in active litigation.`
            : "No tracked facility carries a sourced community-reception status yet.",
        stats: [
          { value: String(reporting), label: "Sites reporting" },
          { value: String(friction), label: "Facing friction" },
        ],
        breakdown: receptionRows,
        breakdownLabel: "Community reception",
        crossLink: { href: "/opposition", label: "the opposition tracker" },
      };
    }
    default:
      return undefined;
  }
}

export async function generateStaticParams() {
  return GLOSSARY_TOPICS.map((t) => ({ topic: t.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ topic: string }>;
}): Promise<Metadata> {
  const { topic: slug } = await params;
  const topic = getGlossaryTopicBySlug(slug);

  if (!topic) {
    return { title: "Topic not found" };
  }

  return {
    title: topic.title,
    description: topic.dek,
    alternates: { canonical: `/learn/${slug}` },
  };
}

/**
 * /learn/[topic] — per-topic glossary explainer page. Static server component.
 *
 * Generated at build time for every entry in GLOSSARY_TOPICS via
 * generateStaticParams. Mirrors app/states/[state]/page.tsx and
 * app/metros/[metro]/page.tsx's dynamic-route convention
 * (generateStaticParams + notFound() on an unknown slug). Each topic pairs
 * its plain-language question (H1) with one factual, dataset-grounded
 * explainer paragraph and the topic's real stat block, sourced from the
 * helper(s) getTopicContent maps it to — never a fabricated figure.
 */
export default async function LearnTopicPage({
  params,
}: {
  params: Promise<{ topic: string }>;
}) {
  const { topic: slug } = await params;
  const topic = getGlossaryTopicBySlug(slug);
  if (!topic) {
    notFound();
  }

  const content = await getTopicContent(slug);
  if (!content) {
    notFound();
  }

  // Exemplar facilities for the cited explainer's sections (if this topic has
  // one) — one getFacilitiesByIds call for every section's exemplarIds
  // combined, never a call per section or per id.
  const exemplarIds = topic.explainer
    ? [...new Set(topic.explainer.sections.flatMap((s) => s.exemplarIds ?? []))]
    : [];
  const exemplarFacilities =
    exemplarIds.length > 0 ? await getFacilitiesByIds(exemplarIds) : [];
  const exemplars = new Map(exemplarFacilities.map((f) => [f.id, f]));

  const crumbs = [
    { label: "Explore", href: "/explore" },
    { label: "Learn", href: "/learn" },
    { label: topic.title },
  ];

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbJsonLdString(
            crumbs.map((c) => ({ name: c.label, url: c.href }))
          ),
        }}
      />

      <Breadcrumb items={crumbs} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <PageMasthead eyebrow="Learn" title={topic.title} dek={topic.dek} />

      {/* ------------------------------------------------------------------ */}
      {/* Cited explainer (editor-approved prose; only some topics have one)  */}
      {/* ------------------------------------------------------------------ */}
      {topic.explainer && (
        <Explainer explainer={topic.explainer} exemplars={exemplars} />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Explainer (dataset-grounded, no fabricated figures)                 */}
      {/* ------------------------------------------------------------------ */}
      <div className="max-w-2xl space-y-4">
        <p className="text-base leading-relaxed text-muted-foreground">
          {content.explainer}
        </p>
        {content.crossLink && (
          <p className="text-base leading-relaxed text-muted-foreground">
            See{" "}
            <Link
              href={content.crossLink.href}
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              {content.crossLink.label}
            </Link>{" "}
            for the full breakdown.
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Survey stats row                                                    */}
      {/* ------------------------------------------------------------------ */}
      <h2 className="sr-only">Key statistics</h2>
      <SurveyStatRow stats={content.stats} />

      {/* ------------------------------------------------------------------ */}
      {/* § Breakdown                                                         */}
      {/* ------------------------------------------------------------------ */}
      {content.breakdown && content.breakdown.length > 0 && (
        <section
          aria-labelledby="breakdown-heading"
          className="space-y-6 border-t border-border pt-10"
        >
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <span aria-hidden="true">§</span> {content.breakdownLabel}
          </p>
          <h2
            id="breakdown-heading"
            className="font-display text-2xl text-foreground"
          >
            {content.breakdownLabel}
          </h2>
          <div className="space-y-4">
            {content.breakdown.map((row) => (
              <div key={row.label} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-foreground">{row.label}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {row.count} <span aria-hidden="true">&middot;</span> {row.pct.toFixed(0)}%
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    aria-hidden="true"
                    className="h-full rounded-full"
                    style={{
                      width: `${row.pct.toFixed(2)}%`,
                      backgroundColor: "var(--primary)",
                      opacity: 0.7,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
