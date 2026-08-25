import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getFacilitiesByStatus } from "@/lib/data";
import { formatPower } from "@/lib/format";
import { STATUS_ORDER, STATUS_META, type Status } from "@/lib/status";
import type { Facility } from "@/lib/schema";
import { CollectionPage } from "@/components/collection/collection-page";

export const revalidate = 3600;

/**
 * The capacity figure shown in each status page's stat row: operational
 * capacity for the operational status, planned capacity for every other
 * (announced-but-not-yet-running) status — a cancelled project's "planned"
 * figure is the capacity that was announced before the cancellation.
 */
function sumCapacityForStatus(facilities: Facility[], status: Status): number {
  if (status === "operational") {
    return facilities.reduce((sum, f) => sum + (f.capacityMw?.operational ?? 0), 0);
  }
  return facilities.reduce((sum, f) => sum + (f.capacityMw?.planned ?? 0), 0);
}

const CAPACITY_STAT_LABEL: Record<Status, string> = {
  operational: "Operational capacity",
  under_construction: "Planned capacity",
  permitted: "Planned capacity",
  proposed: "Planned capacity",
  cancelled: "Planned capacity (cancelled)",
};

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

function parseStatus(raw: string): Status | undefined {
  return STATUS_ORDER.find((s) => s === raw);
}

export async function generateStaticParams() {
  return STATUS_ORDER.map((status) => ({ status }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ status: string }>;
}): Promise<Metadata> {
  const { status: raw } = await params;
  const status = parseStatus(raw);
  if (!status) {
    return { title: "Status not found" };
  }

  const facilities = await getFacilitiesByStatus(status);
  const meta = STATUS_PAGE_META[status];

  return {
    title: meta.title,
    description: meta.describe(facilities.length),
    alternates: { canonical: `/status/${status}` },
  };
}

/**
 * /status/[status] — SEO landing page for one lifecycle status ("proposed
 * data centers", "data centers under construction", etc). Static server
 * component generated at build time for all 5 statuses via
 * generateStaticParams. Renders live data through the CollectionPage
 * primitive — counts and the facility grid are never hardcoded.
 */
export default async function StatusPage({
  params,
}: {
  params: Promise<{ status: string }>;
}) {
  const { status: raw } = await params;
  const status = parseStatus(raw);
  if (!status) {
    notFound();
  }

  const facilities = await getFacilitiesByStatus(status);
  const meta = STATUS_PAGE_META[status];
  const statusLabel = STATUS_META[status].label;
  const capacityMw = sumCapacityForStatus(facilities, status);

  // Dataset-derived fact line: distinct state count mirrors getStats()'s
  // `new Set(...).size` math. facilities.length is reused rather than a
  // separate getStatusCounts() call — getFacilitiesByStatus already gives
  // the exact per-status count. Omitted entirely when the status is empty
  // (the CollectionPage emptyMessage below covers that case instead).
  const stateCount = new Set(facilities.map((f) => f.location.state)).size;
  const factLine =
    facilities.length > 0
      ? `${facilities.length} ${statusLabel.toLowerCase()} facilit${
          facilities.length === 1 ? "y" : "ies"
        }, spanning ${stateCount} state${stateCount === 1 ? "" : "s"}.`
      : null;

  return (
    <CollectionPage
      title={meta.title}
      intro={
        <>
          <p>{meta.intro}</p>
          {factLine && <p>{factLine}</p>}
        </>
      }
      crumbs={[
        { label: "Explore", href: "/explore" },
        { label: "By status", href: "/status" },
        { label: statusLabel },
      ]}
      statRow={[
        { label: "Sites", value: String(facilities.length) },
        { label: CAPACITY_STAT_LABEL[status], value: formatPower(capacityMw) },
      ]}
      facilities={facilities}
      emptyMessage={`No ${statusLabel.toLowerCase()} facilities are on file yet.`}
    />
  );
}
