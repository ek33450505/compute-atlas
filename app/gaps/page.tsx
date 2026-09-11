import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

import { getDatasetGaps, getGapExamples, getStats, type GapCount, type GapDimension } from "@/lib/data";
import { CORRECTABLE_KEYS } from "@/lib/contribute-fields";
import type { Facility } from "@/lib/schema";
import { formatLocation } from "@/lib/format";
import { itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SectionHeading } from "@/components/section-heading";
import { SurveyStatRow, type SurveyStat } from "@/components/survey-stat-row";
import { PercentageBar } from "@/components/percentage-bar";
import { StatusBadge } from "@/components/status-badge";
import { FieldGapPrompt } from "@/components/contribute/field-gap-prompt";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Where the dataset needs help",
  description:
    "The gaps in Compute Atlas's dataset, ranked by what a permit, utility filing, or tax record can actually resolve right now — capacity, subsidies, jobs, energy, water, and single-source records at live and under-construction sites.",
  alternates: { canonical: "/gaps" },
};

/**
 * Shared sentence builder for the five "missing field" dimensions
 * (everything except `singleSource`, which reads differently — see its own
 * `sentence` below). Built as one precomputed string rather than
 * interspersed JSX text: several of these sentences need a contraction-free
 * "does not"/"is not," and even without one, mixing a `{...}` interpolation
 * with adjacent JSX text nodes is the exact shape CLAUDE.md's JSX-entity
 * gotcha warns about — a single string sidesteps the whole class of bug
 * (same technique app/stats/page.tsx documents for its edition line).
 */
function fillableGapSentence(gap: GapCount, missingNoun: string): string {
  const allNote =
    gap.allTotal > gap.fillableTotal
      ? ` Across the whole dataset, ${gap.allMissing} of ${gap.allTotal} sites are missing it — most of the difference is proposed sites, where the figure does not exist yet to find.`
      : "";
  return `${gap.fillableMissing} of ${gap.fillableTotal} operational or under-construction sites carry no ${missingNoun}.${allNote}`;
}

interface GapSectionMeta {
  key: GapDimension;
  /** Section heading text. */
  label: string;
  /** The count sentence for this dimension. */
  sentence: (gap: GapCount) => string;
  /** Concrete "where to look" guidance — the actual value-add of this page. */
  whereToLook: ReactNode;
  /**
   * Maps an example facility to the field/label FieldGapPrompt should
   * target. Only `status` is read (by capacity's branch below); every other
   * section's gapPromptFor ignores its argument. Narrowed to
   * `Pick<Facility, "status">` (rather than the full `Facility`) so
   * `isCorrectable` below can evaluate it against a single representative
   * object instead of a fabricated full Facility.
   */
  gapPromptFor: (f: Pick<Facility, "status">) => { field: string; label: string };
}

/**
 * Derives whether a section is correctable from CORRECTABLE_KEYS instead of
 * a second, hand-maintained boolean per section — that hand-maintained
 * boolean is exactly what drifted: this file shipped a stale `correctable:
 * false` on water/energy after CORRECTABLE_KEYS widened 2026-09-11 to
 * include them, rendering a contradiction (a working correction button
 * under a "no structured correction field yet" note). Mirrors the
 * derivation components/contribute/field-gap-prompt.tsx already does for
 * the button itself. Capacity's two branches (operational vs. planned
 * capacity) are both CORRECTABLE_KEYS members today, so evaluating one
 * representative status is enough — a future branch that disagreed on
 * correctability would need this to check every status.
 */
const CORRECTABILITY_PREVIEW: Pick<Facility, "status"> = { status: "operational" };

function isCorrectable(section: Pick<GapSectionMeta, "gapPromptFor">): boolean {
  return (CORRECTABLE_KEYS as readonly string[]).includes(
    section.gapPromptFor(CORRECTABILITY_PREVIEW).field
  );
}

/**
 * The six gap dimensions, in fillability-ranked display order — the design
 * principle this whole page is built around (see the callout box in the
 * rendered page): capacity, subsidies, and jobs share the clearest public
 * paper trail (permits, interconnection queues, and incentive-agreement
 * packets); energy and water have a real public record too, and, as of the
 * 2026-09-11 CORRECTABLE_KEYS widening, a structured correction form as
 * well — all five are correctable directly here; single-source records are
 * a different kind of gap entirely (corroboration, not discovery), so they
 * close out the page rather than compete on count.
 */
export const GAP_SECTIONS = [
  {
    key: "capacity",
    label: "Capacity",
    sentence: (gap) => fillableGapSentence(gap, "disclosed capacity figure"),
    whereToLook: (
      <>
        County and municipal planning portals (rezoning cases, site plans,
        board-of-supervisors agendas), utility interconnection queues (PJM,
        ERCOT, MISO, and the rest), and SEC filings&rsquo; &ldquo;subsequent
        events&rdquo; footnotes routinely disclose a megawatt figure before
        an operator ever states one in a press release.
      </>
    ),
    gapPromptFor: (f) =>
      f.status === "operational"
        ? { field: "capacityOperationalMw", label: "the operational capacity" }
        : { field: "capacityPlannedMw", label: "the planned capacity" },
  },
  {
    key: "subsidies",
    label: "Subsidies",
    sentence: (gap) => fillableGapSentence(gap, "disclosed subsidy"),
    whereToLook: (
      <>
        A municipal or county government&rsquo;s own ACFR (Annual
        Comprehensive Financial Report) itemizes every active tax-abatement
        agreement under GASB Statement 77 &mdash; including an audited
        statement that none exists. Economic-development board packets and
        incentive agreements are the primary source for the dollar figure
        itself.
      </>
    ),
    gapPromptFor: () => ({ field: "subsidies", label: "a subsidy amount" }),
  },
  {
    key: "jobs",
    label: "Jobs",
    sentence: (gap) => fillableGapSentence(gap, "disclosed jobs figure"),
    whereToLook: (
      <>
        The same incentive agreements and economic-development board packets
        that carry a subsidy figure usually state a construction or
        permanent jobs commitment alongside it &mdash; read the whole
        agreement, not just the headline number.
      </>
    ),
    gapPromptFor: () => ({ field: "jobs", label: "permanent jobs" }),
  },
  {
    key: "energy",
    label: "Energy",
    sentence: (gap) => fillableGapSentence(gap, "disclosed energy source"),
    whereToLook: (
      <>
        Utility interconnection-queue applications, integrated-resource-plan
        filings, and power-purchase-agreement press releases name the source
        and the serving utility.
      </>
    ),
    gapPromptFor: () => ({ field: "energy", label: "energy details" }),
  },
  {
    key: "water",
    label: "Water",
    sentence: (gap) => fillableGapSentence(gap, "disclosed cooling or water detail"),
    whereToLook: (
      <>
        State environmental agencies&rsquo; water-use or discharge permits,
        and, for the largest sites, an EIS or combined air/water permit
        filing, are the primary public source for cooling method and usage.
      </>
    ),
    gapPromptFor: () => ({ field: "water", label: "the cooling method" }),
  },
  {
    key: "singleSource",
    label: "Needs a second source",
    sentence: (gap) =>
      `${gap.fillableMissing} of ${gap.fillableTotal} operational or under-construction sites cite exactly one source — a fact that is established, not yet corroborated. Across the whole dataset, ${gap.allMissing} of ${gap.allTotal} sites are in the same position.`,
    whereToLook: (
      <>
        This is not a missing fact &mdash; it is a missing second witness. A
        local news report, a county record, or the operator&rsquo;s own
        filing that confirms what is already on file is enough.
      </>
    ),
    gapPromptFor: () => ({ field: "secondSource", label: "additional corroboration" }),
  },
] satisfies GapSectionMeta[];

/**
 * /gaps — recruits contributors by naming the dataset's incompleteness
 * concretely instead of rendering it as a silent omission or a bare em-dash.
 * Static server component; data is recomputed live from `lib/data.ts` on
 * the shared hourly `loadFacilities()` cache (see `getDatasetGaps` /
 * `getGapExamples`) rather than the hand-run census this page was designed
 * against, so the numbers here self-correct as the dataset grows.
 *
 * Design principle: sections are ordered by how FINDABLE each gap is, not
 * by how large it is — a `proposed` site missing jobs data is a structural
 * zero (the fact hasn't happened yet), so every count and example on this
 * page is scoped to operational + under_construction sites (`getGapExamples`
 * / `getDatasetGaps`'s `fillable*` fields), never the whole dataset.
 */
export default async function GapsPage() {
  const [gaps, stats, examplesByDim] = await Promise.all([
    getDatasetGaps(),
    getStats(),
    Promise.all(GAP_SECTIONS.map((section) => getGapExamples(section.key))),
  ]);

  const jsonLdFacilities = examplesByDim.flat();
  const surveyStats: SurveyStat[] = [
    { value: stats.count.toLocaleString(), label: "Facilities tracked" },
    {
      value: gaps.capacity.fillableTotal.toLocaleString(),
      label: "Operational or building",
    },
    {
      value: gaps.singleSource.fillableMissing.toLocaleString(),
      label: "Cite one source",
    },
  ];

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: itemListJsonLdString(
            jsonLdFacilities.map((f) => ({
              name: f.name,
              url: `${siteConfig.url}/facilities/${f.id}`,
            }))
          ),
        }}
      />

      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Gaps" }]} />

      <PageMasthead
        eyebrow="Contribute"
        title="Where the dataset needs help."
        dek={
          <>
            An honest account of what has not been researched yet &mdash;
            not doubt about what is already sourced. Every figure on Compute
            Atlas traces to a public record; what follows is a ranked list
            of the facts nobody has found yet, and where to find them.
          </>
        }
      />

      <SurveyStatRow stats={surveyStats} />

      <div className="neatline rounded-sm border border-primary/40 bg-muted/20 p-6 sm:p-8 space-y-3">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          How this page is ordered
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Sections below are ranked by how findable each gap actually is,
          not by how large it is. A proposed site missing a jobs figure is a
          structural zero &mdash; the project has not broken ground, so
          there is no figure yet to find, and sending someone after it wastes
          their goodwill. Every count and example here is scoped to
          operational and under-construction sites instead, where a permit,
          utility filing, or public record can genuinely resolve the gap.
        </p>
      </div>

      {GAP_SECTIONS.map((section, i) => {
        const gap = gaps[section.key];
        const examples = examplesByDim[i];
        return (
          <section
            key={section.key}
            aria-labelledby={`${section.key}-heading`}
            className="space-y-5 border-t border-border pt-10"
          >
            <SectionHeading
              kicker={`${i + 1} of ${GAP_SECTIONS.length}`}
              id={`${section.key}-heading`}
              title={section.label}
            />

            <p className="max-w-2xl text-base text-muted-foreground">
              {section.sentence(gap)}
            </p>

            <PercentageBar
              label="Filled among operational & under-construction sites"
              valueLabel={
                <>
                  {gap.fillableTotal - gap.fillableMissing} / {gap.fillableTotal}
                </>
              }
              pct={
                gap.fillableTotal > 0
                  ? ((gap.fillableTotal - gap.fillableMissing) / gap.fillableTotal) * 100
                  : 0
              }
            />

            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              <strong className="font-medium text-foreground">Where to look: </strong>
              {section.whereToLook}{" "}
              {isCorrectable(section) ? (
                <span className="italic">
                  Correctable directly below &mdash; use the prompt on any example.
                </span>
              ) : (
                <span className="italic">
                  No structured correction field yet &mdash; send a source
                  link from the prompt below and we will apply it.
                </span>
              )}
            </p>

            {examples.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open examples on file right now among operational and
                under-construction sites for this dimension.
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {examples.map((f) => {
                  const prompt = section.gapPromptFor(f);
                  // Built as one precomputed string (not interspersed JSX
                  // text) deliberately: a text chunk that follows a `{...}`
                  // interpolation and contains an HTML entity (&middot; etc.)
                  // can have its leading space silently dropped by the JSX
                  // transform — see CLAUDE.md's JSX-entity-space gotcha and
                  // app/stats/page.tsx's edition line. A literal "·"
                  // character inside one JS string sidesteps that bug class.
                  const operatorLocation = `${f.operator} · ${formatLocation(f)}`;
                  return (
                    <li
                      key={f.id}
                      className="neatline flex flex-col gap-2 rounded-sm border border-border p-4"
                    >
                      <Link
                        href={`/facilities/${f.id}`}
                        className="group flex flex-col gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <span className="font-display text-base leading-snug text-foreground group-hover:text-primary transition-colors motion-reduce:transition-none">
                          {f.name}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground truncate">
                          {operatorLocation}
                        </span>
                      </Link>
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <StatusBadge status={f.status} />
                        <FieldGapPrompt
                          field={prompt.field}
                          facilityId={f.id}
                          facilityName={f.name}
                          label={prompt.label}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      <section
        aria-labelledby="gaps-cta-heading"
        className="space-y-4 border-t border-border pt-10"
      >
        <SectionHeading
          kicker="Get involved"
          id="gaps-cta-heading"
          title="Have a lead that does not fit above?"
        />
        {/*
          `stakeholders` is the only example named here on purpose. This
          sentence used to read "stakeholders, emissions, community response",
          but the 2026-09-11 CORRECTABLE_KEYS widening gave emissions and
          community their own structured correction forms — citing them as
          things that need the lead path would now send people the long way
          round. `stakeholders` stays because it is deliberately excluded from
          public intake (see CLAUDE.md and the CORRECTABLE_KEYS doc comment),
          so the lead path really is the only route for it.
        */}
        <p className="max-w-2xl text-base text-muted-foreground">
          A new facility, a status change, or a fact about something outside
          these six dimensions &mdash; stakeholders, or anything else worth
          a second look &mdash; is just as useful. Send a link and we will
          take it from there.
        </p>
        <Link
          href="/contribute"
          className="inline-flex min-h-11 items-center rounded-sm border border-primary/40 bg-primary/5 px-4 text-sm font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Share a lead
        </Link>
      </section>
    </div>
  );
}
