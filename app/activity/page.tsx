import type { Metadata } from "next";

import { getRecentActivity } from "@/lib/data";
import { ActivityList } from "@/app/activity/activity-list";

export const metadata: Metadata = {
  title: "Recent activity",
  description:
    "Recently-updated facilities and recently-approved contributions to Compute Atlas.",
};

const ACTIVITY_LIMIT = 50;

/**
 * Public activity feed — no auth. Server component: unified reverse-chron
 * view combining recently-updated facilities and recently-approved
 * community contributions into a single list (see `getRecentActivity`).
 */
export default async function ActivityPage() {
  const entries = await getRecentActivity(ACTIVITY_LIMIT);

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="mb-8 space-y-2 border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          Live record
        </p>
        <h1 className="font-display text-3xl text-foreground sm:text-4xl">
          Recent activity
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
          The latest facility updates and approved community contributions,
          most recent first.
        </p>
      </div>

      <ActivityList entries={entries} />
    </div>
  );
}
