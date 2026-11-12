import Link from "next/link";
import type { Metadata } from "next";

import {
  getFacilitiesByCommunityStatus,
  getCommunityReceptionCounts,
  getFrictionTotal,
  getNotableOppositionCases,
  getDefeatedProjects,
} from "@/lib/data";
import {
  COMMUNITY_RECEPTION_META,
  OPPOSITION_HEADLINE,
  type CommunityReception,
} from "@/lib/community";
import { formatLocation } from "@/lib/format";
import {
  FRICTION_CAUSES_FINDING,
  FRICTION_ELECTRICITY_CONTRAST,
} from "@/lib/glossary";
import { statesStat, statesPhrase, stateNameFromCode } from "@/lib/us-states";
import { parseStateParam, stateCounts } from "@/lib/state-index";
import { itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow, type SurveyStat } from "@/components/survey-stat-row";
import { PercentageBar } from "@/components/percentage-bar";
import { SectionHeading } from "@/components/section-heading";
import { StateNav } from "@/components/collection/state-nav";

/** Withdrawn-or-defeated rows shown on the default view; the rest sit under their state. */
const DEFEATED_SHOWN = 12;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Most-severe-first display order for the friction statuses shown on this page. */
const FRICTION_ORDER = ["litigation", "opposed", "contested"] as const satisfies readonly CommunityReception[];

/** Codes of the states that hold at least one friction site. */
async function frictionStates(): Promise<Set<string>> {
  const groups = await Promise.all(
    FRICTION_ORDER.map((status) => getFacilitiesByCommunityStatus(status))
  );
  return new Set(groups.flatMap((g) => g.map((f) => f.location.state)));
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const state = parseStateParam((await searchParams).state, await frictionStates());
  const description =
    "The U.S. compute sites facing documented community friction — litigation, moratoria, referendums, and formal opposition, each with a public source. Part of Compute Atlas.";
  if (!state) {
    return {
      title: "Data center opposition & community response",
      description,
      alternates: { canonical: "/opposition" },
    };
  }
  return {
    title: `Data center opposition in ${stateNameFromCode(state)}`,
    description,
    alternates: { canonical: `/opposition?state=${state.toLowerCase()}` },
  };
}

/**
 * /opposition — index of tracked sites with sourced local friction.
 *
 * The default view carries the summary, the notable cases, the largest
 * withdrawn projects, and a link per state; `?state=xx` lists every friction
 * site in that state. Why: listing all ~590 sites with their notes was a
 * 2.5 MB document (audit U-11) because the RSC payload repeats every row.
 * Row notes live on the facility page, not in this index. Reading
 * `searchParams` makes the route dynamic; data still comes through the
 * 24 h-cached loader.
 *
 * Surfaces facilities whose community.status is contested, opposed, or in
 * litigation — the subset of the dataset with documented pushback. This is
 * not a claim about the buildout as a whole: non-friction statuses
 * (supported, mixed, unknown) are out of scope for this page. Mirrors the
 * /power and /stats visual language (masthead, survey-stat row, § progress-bar
 * sections, block-Link rows).
 */
export default async function OppositionPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const counts = await getCommunityReceptionCounts();
  const notableCases = await getNotableOppositionCases();
  const defeatedProjects = await getDefeatedProjects();
  const groups = await Promise.all(
    FRICTION_ORDER.map(async (status) => ({
      status,
      facilities: await getFacilitiesByCommunityStatus(status),
    }))
  );
  const total = getFrictionTotal(counts);
  const frictionStateCodes = new Set(
    groups.flatMap((g) => g.facilities.map((f) => f.location.state))
  );
  const state = parseStateParam((await searchParams).state, frictionStateCodes);
  const statesTile = statesStat(frictionStateCodes);
  const stateList = stateCounts(
    groups.flatMap((g) => g.facilities.map((f) => f.location.state))
  );
  const stateGroups = state
    ? groups
        .map((g) => ({
          ...g,
          facilities: g.facilities.filter((f) => f.location.state === state),
        }))
        .filter((g) => g.facilities.length > 0)
    : [];
  // A withdrawn project that is also a notable case is already rendered above.
  const shownDefeated = defeatedProjects
    .filter((d) => !notableCases.some((n) => n.id === d.id))
    .slice(0, DEFEATED_SHOWN);
  const jsonLdFacilities = state
    ? stateGroups.flatMap((g) => g.facilities)
    : [...notableCases, ...shownDefeated];
  const surveyStats: SurveyStat[] = state
    ? [
        {
          value: stateGroups.reduce((n, g) => n + g.facilities.length, 0),
          label: "Friction sites",
        },
        {
          value:
            stateGroups.find((g) => g.status === "litigation")?.facilities.length ?? 0,
          label: "In litigation",
        },
      ]
    : [
        { value: total, label: "Friction sites" },
        { value: counts.litigation, label: "In litigation" },
        { ...statesTile },
      ];
  if (!state && defeatedProjects.length > 0) {
    surveyStats.push({
      value: defeatedProjects.length,
      label: "Withdrawn after opposition",
    });
  }

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

      <Breadcrumb
        items={
          state
            ? [
                { label: "Explore", href: "/explore" },
                { label: "Opposition", href: "/opposition" },
                { label: stateNameFromCode(state) ?? state },
              ]
            : [{ label: "Explore", href: "/explore" }, { label: "Opposition" }]
        }
      />

      <PageMasthead
        eyebrow="Community friction"
        title={OPPOSITION_HEADLINE}
        dek="Where the buildout meets resistance."
      >
        <p className="max-w-2xl text-base text-muted-foreground">
          Tracked sites with documented local friction — lawsuits, moratoria,
          referendums, and formal opposition. This is not a claim about the
          buildout as a whole; it is the sourced subset facing pushback, and
          every entry links to a source-cited record.
        </p>
      </PageMasthead>

      {total === 0 ? (
        <p className="text-base text-muted-foreground">
          No documented community friction is on file yet.
        </p>
      ) : (
        <>
          {state && <SurveyStatRow stats={surveyStats} />}
          {!state && (
          <>
          <div className="max-w-2xl space-y-4 text-base text-muted-foreground">
            <p>
              Compute Atlas has sourced {total} facilities with a documented friction
              status: {counts.litigation} {counts.litigation === 1 ? "is" : "are"} in
              active litigation, {counts.opposed}{" "}
              {counts.opposed === 1 ? "faces" : "face"} formal opposition, and{" "}
              {counts.contested} {counts.contested === 1 ? "is" : "are"} contested. Each
              status traces to a cited local source — a court filing, a news report, a
              public meeting record — rather than an editorial read of how a community
              feels.
            </p>
            <p>
              These disputes are rarely about data centers in the abstract.
              In the records Compute Atlas tracks, they turn on a specific
              local consequence — a well, a noise complaint, a hearing
              residents heard about only after it was underway.{" "}
              {FRICTION_CAUSES_FINDING} {FRICTION_ELECTRICITY_CONTRAST} See{" "}
              <Link
                href="/learn/why-do-communities-oppose-data-centers"
                className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
              >
                why communities oppose data centers
              </Link>{" "}
              for the sourced case-by-case breakdown.
            </p>
            <p>
              Those sites span {statesPhrase(frictionStateCodes)}{" "}
              across the country. A
              facility with no friction status on file has not necessarily been
              welcomed locally — it may simply be a project nobody has yet documented
              a public objection to.
            </p>
          </div>

          {notableCases.length > 0 && (
            <section
              aria-labelledby="notable-cases-heading"
              className="space-y-6 border-t border-border pt-10"
            >
              <SectionHeading kicker="Notable 2026 cases" id="notable-cases-heading" title="Notable 2026 cases" />
              <p className="max-w-2xl text-base text-muted-foreground">
                Opposition to data centers has become a national trend in 2026:
                Good Jobs First counted 833 active community opposition groups
                nationwide, up from 396 the year before — a wave that, per
                Tom&rsquo;s Hardware, has delayed an estimated $130 billion in
                projects. That figure is an external, national estimate, not a
                Compute Atlas count. The cases below are individual sites from
                Compute Atlas&rsquo;s own sourced dataset.
              </p>
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {notableCases.map((f) => (
                  <li key={f.id}>
                    <Link
                      href={`/facilities/${f.id}`}
                      className="neatline group flex h-full flex-col gap-2 rounded-sm border border-border p-4 transition-colors motion-reduce:transition-none hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <span className="font-display text-base leading-snug text-foreground group-hover:text-primary transition-colors motion-reduce:transition-none">
                        {f.name}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatLocation(f)}
                      </span>
                      {f.community?.notes && (
                        <p className="text-xs text-muted-foreground line-clamp-3">
                          {f.community.notes}
                        </p>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <SurveyStatRow stats={surveyStats} />

          {shownDefeated.length > 0 && (
            <section
              aria-labelledby="defeated-heading"
              className="space-y-6 border-t border-border pt-10"
            >
              <SectionHeading kicker="Withdrawn or defeated" id="defeated-heading" title="Withdrawn or defeated" />
              <p className="max-w-2xl text-base text-muted-foreground">
                {defeatedProjects.length} cancelled{" "}
                {defeatedProjects.length === 1 ? "project" : "projects"} in Compute
                Atlas&rsquo;s dataset faced documented local opposition before the
                cancellation — a lawsuit, a moratorium, a referendum, or formal
                objection on record. That is a correlation, not a causal claim:
                Compute Atlas does not assert opposition stopped any of these
                projects, since a cancellation can have economic or other causes
                that go unstated publicly.{" "}
                {defeatedProjects.length > shownDefeated.length
                  ? "The largest are listed below, apart from any notable case above; every one also appears under its state, marked cancelled. "
                  : ""}
                Each entry links to a source-cited record. For background on why local pushback
                happens, see{" "}
                <Link
                  href="/learn/why-do-communities-oppose-data-centers"
                  className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
                >
                  why communities oppose data centers
                </Link>
                .
              </p>
              <ul className="divide-y divide-border">
                {shownDefeated.map((f) => (
                  <li key={f.id}>
                    <Link
                      href={`/facilities/${f.id}`}
                      className="flex min-h-11 flex-col gap-1 py-3 transition-colors motion-reduce:transition-none hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
                    >
                      <span className="flex items-center justify-between gap-4">
                        <span className="text-sm text-foreground truncate">
                          {f.name}
                        </span>
                        <span className="shrink-0">
                          <StatusBadge status={f.status} />
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground truncate">
                        {f.operator} &middot; {formatLocation(f)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section
            aria-labelledby="reception-heading"
            className="space-y-6 border-t border-border pt-10"
          >
            <SectionHeading kicker="By reception" id="reception-heading" title="By reception" />
            <div className="space-y-4">
              {FRICTION_ORDER.map((status) => {
                const count = counts[status];
                const pct = total > 0 ? (count / total) * 100 : 0;
                return (
                  <PercentageBar
                    key={status}
                    label={COMMUNITY_RECEPTION_META[status].label}
                    valueLabel={
                      <>
                        {count} &middot; {pct.toFixed(0)}%
                      </>
                    }
                    pct={pct}
                  />
                );
              })}
            </div>
          </section>

          </>
          )}

          <section
            aria-labelledby="sites-heading"
            className="space-y-8 border-t border-border pt-10"
          >
            <SectionHeading
              kicker={state ? "The sites" : "By state"}
              id="sites-heading"
              title={state ? `Friction sites in ${stateNameFromCode(state)}` : "Sites by state"}
            />
            <StateNav
              basePath="/opposition"
              label="Friction sites by state"
              states={stateList}
              current={state}
              noun={["site", "sites"]}
            />
            <div className="space-y-8">
              {stateGroups.map((group) => (
                <div key={group.status} className="space-y-3">
                  <h3 className="text-sm font-medium text-foreground">
                    {COMMUNITY_RECEPTION_META[group.status].label} &middot; {group.facilities.length}
                  </h3>
                  <ul className="divide-y divide-border">
                    {group.facilities.map((f) => (
                      <li key={f.id}>
                        <Link
                          href={`/facilities/${f.id}`}
                          className="flex min-h-11 flex-col gap-1 py-3 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
                        >
                          <span className="flex items-center justify-between gap-4">
                            <span className="text-sm text-foreground truncate">
                              {f.name}
                            </span>
                            <span className="shrink-0">
                              <StatusBadge status={f.status} hideIcon />
                            </span>
                          </span>
                          <span className="text-xs text-muted-foreground truncate">
                            {f.operator} &middot; {formatLocation(f)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
