import type { Metadata } from "next";
import { Rss } from "lucide-react";

import { getRecentActivity } from "@/lib/data";
import { ActivityList } from "@/app/activity/activity-list";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Recent activity",
  description:
    "Recently-updated facilities and recently-approved contributions to Compute Atlas.",
  alternates: { canonical: "/activity" },
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
        <p className="pt-1">
          <a
            href="/activity/feed.xml"
            className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-primary underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            <Rss aria-hidden="true" className="h-3.5 w-3.5" />
            Subscribe via RSS
          </a>
        </p>
      </div>

      <ActivityList entries={entries} />
    </div>
  );
}
