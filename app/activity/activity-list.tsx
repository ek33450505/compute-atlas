import Link from "next/link";

import type { ActivityEntry } from "@/lib/data";

interface ActivityListProps {
  entries: ActivityEntry[];
}

/**
 * Renders a reverse-chronological list of activity entries — facility name
 * linked to its detail page, a short change label, and a timestamp.
 *
 * Deliberately does NOT render a diff/summary of what changed — that's the
 * separate audit-log feature. This is a lightweight "what happened" feed.
 */
export function ActivityList({ entries }: ActivityListProps) {
  if (entries.length === 0) {
    return (
      <p className="font-mono text-sm text-muted-foreground">
        No recent activity yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {entries.map((entry, i) => (
        <li
          key={`${entry.kind}-${entry.facilityId}-${entry.timestamp.getTime()}-${i}`}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0">
            {entry.facilityId ? (
              <Link
                href={`/facilities/${entry.facilityId}`}
                className="font-display text-base text-foreground underline underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              >
                {entry.facilityName}
              </Link>
            ) : (
              <span className="font-display text-base text-foreground">
                {entry.facilityName}
              </span>
            )}
            <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              {entry.label}
            </span>
          </div>
          <time
            dateTime={entry.timestamp.toISOString()}
            className="font-mono text-xs text-muted-foreground shrink-0"
          >
            {entry.timestamp.toLocaleDateString()}
          </time>
        </li>
      ))}
    </ul>
  );
}
