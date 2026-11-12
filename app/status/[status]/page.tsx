import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getFacilitiesByStatus } from "@/lib/data";
import {
  STATUS_CAPACITY_LABEL,
  capacityTierForStatus,
  sumCapacityMw,
} from "@/lib/capacity-sums";
import { formatPower } from "@/lib/format";
import { STATUS_ORDER, STATUS_META, parseStatus, type Status } from "@/lib/status";
import { statesPhrase, stateNameFromCode } from "@/lib/us-states";
import { parseStateParam, stateCounts } from "@/lib/state-index";
import { CollectionPage } from "@/components/collection/collection-page";
import { StateNav } from "@/components/collection/state-nav";

/** Facilities shown on the default view; the full list sits under each state. */
const TOP_SHOWN = 48;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Per-status editorial copy — title (inherits the root layout's
 * "%s · Compute Atlas" template, so it is never self-appended here),
 * a fact-forward meta description generator, and a short intro paragraph in
 * the site's de-sold, source-cited voice.
 */
const STATUS_PAGE_META: Record<
  Status,
  { title: string; describe: (count: number) => string; intro: string }
> = {
  proposed: {
    title: "Proposed data centers in the US",
    describe: (count) =>
      `${count} proposed data center${count === 1 ? "" : "s"} tracked across the US — announced but not yet approved, each traced to a public source.`,
    intro:
      "Facilities with an announced-but-unapproved status: a company or filing has signaled intent, but no permit has been granted yet. Each entry traces to a public filing, press report, or economic-development announcement.",
  },
  permitted: {
    title: "Permitted data centers in the US",
    describe: (count) =>
      `${count} permitted data center${count === 1 ? "" : "s"} tracked across the US — approved but not yet under construction, each with a public source.`,
    intro:
      "Facilities that have cleared local permitting or zoning approval but haven't broken ground. Each entry traces to a public permit record, planning-commission filing, or local report.",
  },
  under_construction: {
    title: "Data centers under construction in the US",
    describe: (count) =>
      `${count} data center${count === 1 ? "" : "s"} currently under construction across the US, each traced to a public filing or report.`,
    intro:
      "Facilities actively being built — ground has broken and construction is underway. Each entry traces to a public permit, filing, or local report documenting the build.",
  },
  operational: {
    title: "Operational data centers in the US",
    describe: (count) =>
      `${count} operational data center${count === 1 ? "" : "s"} tracked across the US — built and running, each with a public source.`,
    intro:
      "Facilities that are built and running today. Each entry traces to a public filing, utility record, or report confirming the site is live.",
  },
  cancelled: {
    title: "Cancelled data center projects",
    describe: (count) =>
      `${count} cancelled or withdrawn data center project${count === 1 ? "" : "s"} tracked across the US, each with a public source documenting the cancellation.`,
    intro:
      "Proposed or permitted projects that were later cancelled or withdrawn. Each entry traces to a public source documenting the decision — tracked here so the record of what didn't get built stays visible too.",
  },
};

// No longer drives rendering: reading `searchParams` opts the page into
// dynamic rendering. Kept as the list of valid slugs and tested by
// status-params.test.ts. `revalidate` is dropped for the same reason.
export async function generateStaticParams() {
  return STATUS_ORDER.map((status) => ({ status }));
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ status: string }>;
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { status: raw } = await params;
  const status = parseStatus(raw);
  if (!status) {
    return { title: "Status not found" };
  }

  const facilities = await getFacilitiesByStatus(status);
  const meta = STATUS_PAGE_META[status];
  const state = parseStateParam(
    (await searchParams).state,
    new Set(facilities.map((f) => f.location.state))
  );

  if (!state) {
    return {
      title: meta.title,
      description: meta.describe(facilities.length),
      alternates: { canonical: `/status/${status}` },
    };
  }

  const stateName = stateNameFromCode(state) ?? state;
  const inState = facilities.filter((f) => f.location.state === state).length;
  return {
    title: `${meta.title.replace(/ in the US$/, "")} in ${stateName}`,
    description: meta.describe(inState).replace("across the US", `in ${stateName}`),
    alternates: { canonical: `/status/${status}?state=${state.toLowerCase()}` },
  };
}

/**
 * /status/[status] — SEO landing page for one lifecycle status ("proposed
 * data centers", "data centers under construction", etc). Renders live data
 * through the CollectionPage primitive — counts and the facility grid are
 * never hardcoded.
 *
 * The default view lists only the TOP_SHOWN largest facilities (by disclosed
 * capacity, the order getFacilitiesByStatus returns) plus a link per state;
 * `?state=xx` lists every facility of that status in that state. Why: the
 * full list was 4.73 MB for operational (1,492 sites), 3.05 MB for proposed,
 * because every card ships in the HTML and RSC payload even when hidden by
 * "show more", past Google's 2 MB fetch cap (GSC audit 2026-11-12, F2).
 * Reading `searchParams` makes the route dynamic, so `revalidate` is gone;
 * data still comes through the 24 h-cached loader.
 */
export default async function StatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ status: string }>;
  searchParams: SearchParams;
}) {
  const { status: raw } = await params;
  const status = parseStatus(raw);
  if (!status) {
    notFound();
  }

  const allFacilities = await getFacilitiesByStatus(status);
  const meta = STATUS_PAGE_META[status];
  const statusLabel = STATUS_META[status].label;
  const state = parseStateParam(
    (await searchParams).state,
    new Set(allFacilities.map((f) => f.location.state))
  );
  const stateName = state ? (stateNameFromCode(state) ?? state) : null;
  // The stat row and fact line describe the full set (default view) or the
  // state subset (state view), never the shown slice.
  const facilities = state
    ? allFacilities.filter((f) => f.location.state === state)
    : allFacilities;
  const shown = state ? facilities : facilities.slice(0, TOP_SHOWN);
  const capacityMw = sumCapacityMw(facilities, capacityTierForStatus(status));

  // Dataset-derived fact line: distinct state count mirrors getStats()'s
  // `new Set(...).size` math. Omitted entirely when the status is empty
  // (the CollectionPage emptyMessage below covers that case instead).
  const stateCodes = new Set(facilities.map((f) => f.location.state));
  const factLine =
    facilities.length > 0
      ? state
        ? `${facilities.length} ${statusLabel.toLowerCase()} facilit${
            facilities.length === 1 ? "y" : "ies"
          } in ${stateName}.`
        : `${facilities.length} ${statusLabel.toLowerCase()} facilit${
            facilities.length === 1 ? "y" : "ies"
          }, spanning ${statesPhrase(stateCodes)}.`
      : null;

  const statusCrumb = state
    ? [
        { label: statusLabel, href: `/status/${status}` },
        { label: stateName ?? state },
      ]
    : [{ label: statusLabel }];

  return (
    <CollectionPage
      title={state ? `${meta.title.replace(/ in the US$/, "")} in ${stateName}` : meta.title}
      intro={
        <>
          <p>{meta.intro}</p>
          {factLine && <p>{factLine}</p>}
        </>
      }
      crumbs={[
        { label: "Explore", href: "/explore" },
        { label: "By status", href: "/status" },
        ...statusCrumb,
      ]}
      statRow={[
        { label: "Sites", value: String(facilities.length) },
        { label: STATUS_CAPACITY_LABEL[status], value: formatPower(capacityMw) },
      ]}
      facilities={shown}
      emptyMessage={`No ${statusLabel.toLowerCase()} facilities are on file yet.`}
      beforeGrid={
        facilities.length > 0 && (
          <div className="space-y-4">
            {!state && facilities.length > TOP_SHOWN && (
              <p className="max-w-2xl text-base text-muted-foreground">
                Showing {TOP_SHOWN} of {facilities.length}, largest disclosed
                capacity first. Pick a state for the full list.
              </p>
            )}
            <StateNav
              basePath={`/status/${status}`}
              label={`${statusLabel} facilities by state`}
              states={stateCounts(allFacilities.map((f) => f.location.state))}
              current={state}
              noun={["facility", "facilities"]}
            />
          </div>
        )
      }
    />
  );
}
