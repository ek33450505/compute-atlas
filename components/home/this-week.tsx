import Link from "next/link";

import type { ActivityEntry } from "@/lib/data";
import { SectionHeading } from "@/components/section-heading";
import { formatEditionDate } from "@/lib/edition-date";
import { StatusBadge } from "@/components/status-badge";
import type { Status } from "@/lib/status";
import { stateNameFromCode } from "@/lib/us-states";

export interface ThisWeekProps {
  entries: ActivityEntry[];
  now: Date;
  /** True when the fetched window ended inside the 7 days, so counts are lower bounds. */
  truncated: boolean;
  /** Current status and state per facility id, for the badge and place on each row. */
  places?: Record<string, { status: Status; state: string }>;
  className?: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 7;

// Same trailing-link idiom as components/home/open-record.tsx.
const TRAILING_LINK_CLASS =
  "inline-flex min-h-11 items-center rounded-sm font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function countPhrase(n: number, truncated: boolean, one: string, many: string) {
  return `${n.toLocaleString("en-US")}${truncated ? "+" : ""} ${n === 1 && !truncated ? one : many}`;
}

/**
 * True when the fetch hit its limit and its oldest (last) row is still inside
 * the 7-day window, so older in-window rows may have been cut off.
 */
export function isActivityWindowTruncated(
  entries: ActivityEntry[],
  limit: number,
  now: Date
): boolean {
  if (entries.length === 0 || entries.length < limit) return false;
  return now.getTime() - entries[entries.length - 1].timestamp.getTime() <= WEEK_MS;
}

/** The window's end, as the day the page was rendered (UTC, same zone as the row dates). */
const windowLine = (now: Date) => `The 7 days to ${formatEditionDate(now.toISOString())}.`;

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * "Last 7 days" change feed: counts of sites added and records updated in the
 * 7 days before `now`, then the latest rows (what changed, where, current
 * status) with a link to /activity. The feed already excludes notes-only
 * (editorial) history rows, so it means what /activity means. A quiet week
 * gets a short plain line and the same link, not a hidden section.
 */
export function ThisWeek({ entries, now, truncated, places, className }: ThisWeekProps) {
  const cutoff = now.getTime() - WEEK_MS;
  const recent = entries.filter((e) => {
    const t = e.timestamp.getTime();
    return t >= cutoff && t <= now.getTime();
  });
  if (recent.length === 0) {
    return (
      <section aria-labelledby="this-week-heading" className={className}>
        <SectionHeading kicker="Activity" id="this-week-heading" title="Last 7 days" />
        <p className="mt-2 text-sm text-muted-foreground">
          {windowLine(now)} No changes to the records in that window.
        </p>
        <Link href="/activity" className={TRAILING_LINK_CLASS}>
          All activity<span aria-hidden="true"> →</span>
        </Link>
      </section>
    );
  }

  const added = recent.filter((e) => e.kind === "create").length;
  const updated = recent.length - added;

  return (
    <section aria-labelledby="this-week-heading" className={className}>
      <div className="space-y-1">
        <SectionHeading kicker="Activity" id="this-week-heading" title="Last 7 days" />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{windowLine(now)}</p>
      <p className="mt-1 font-mono text-sm text-muted-foreground">
        {[
          added > 0 && countPhrase(added, truncated, "site added", "sites added"),
          updated > 0 && countPhrase(updated, truncated, "record updated", "records updated"),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <ul className="mt-3 flex flex-col divide-y divide-border">
        {recent.slice(0, RECENT_LIMIT).map((entry, i) => {
          const place = places?.[entry.facilityId];
          const stateName = place ? stateNameFromCode(place.state) : undefined;
          return (
            <li
              key={`${entry.kind}-${entry.facilityId}-${entry.timestamp.getTime()}-${i}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1"
            >
              <Link
                href={`/facilities/${entry.facilityId}`}
                className="inline-flex min-h-11 items-center rounded-sm font-display text-base text-foreground underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {entry.facilityName}
              </Link>
              <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                {entry.label}
                {stateName ? ` · ${stateName}` : ""} · {DAY_FORMAT.format(entry.timestamp)}
              </span>
              {place && (
                <span className="inline-flex items-baseline gap-1.5">
                  <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Now:
                  </span>
                  <StatusBadge status={place.status} hideIcon />
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <Link href="/activity" className={TRAILING_LINK_CLASS}>
        All activity<span aria-hidden="true"> →</span>
      </Link>
    </section>
  );
}
