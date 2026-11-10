import Link from "next/link";

import type { ActivityEntry } from "@/lib/data";
import { SectionHeading } from "@/components/section-heading";

export interface ThisWeekProps {
  entries: ActivityEntry[];
  now: Date;
  /** True when the fetched window ended inside the 7 days, so counts are lower bounds. */
  truncated: boolean;
  className?: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 3;

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

/**
 * Compact "Last 7 days" band under the hero: counts of sites added and records
 * updated in the 7 days before `now`, plus the three latest entries. Renders
 * nothing when the window is empty (no DB, or a quiet week). The feed already
 * excludes notes-only (editorial) history rows, so the counts mean what
 * /activity means.
 */
export function ThisWeek({ entries, now, truncated, className }: ThisWeekProps) {
  const cutoff = now.getTime() - WEEK_MS;
  const recent = entries.filter((e) => {
    const t = e.timestamp.getTime();
    return t >= cutoff && t <= now.getTime();
  });
  if (recent.length === 0) return null;

  const added = recent.filter((e) => e.kind === "create").length;
  const updated = recent.length - added;

  return (
    <section aria-labelledby="this-week-heading" className={className}>
      <div className="space-y-1">
        <SectionHeading kicker="Activity" id="this-week-heading" title="Last 7 days" />
      </div>
      <p className="mt-2 font-mono text-sm text-muted-foreground">
        {[
          added > 0 && countPhrase(added, truncated, "site added", "sites added"),
          updated > 0 && countPhrase(updated, truncated, "record updated", "records updated"),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <ul className="mt-3 flex flex-col divide-y divide-border">
        {recent.slice(0, RECENT_LIMIT).map((entry, i) => (
          <li
            key={`${entry.kind}-${entry.facilityId}-${entry.timestamp.getTime()}-${i}`}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
          >
            <Link
              href={`/facilities/${entry.facilityId}`}
              className="inline-flex min-h-11 items-center rounded-sm font-display text-base text-foreground underline underline-offset-4 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {entry.facilityName}
            </Link>
            <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              {entry.label}
            </span>
          </li>
        ))}
      </ul>
      <Link href="/activity" className={TRAILING_LINK_CLASS}>
        All activity →
      </Link>
    </section>
  );
}
