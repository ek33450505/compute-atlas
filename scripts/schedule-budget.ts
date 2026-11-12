/**
 * Day-aware staleness budget for a weekday-scheduled job.
 *
 *   budget(now) = 24 * (days back from TODAY to the most recent scheduled
 *                       weekday STRICTLY BEFORE today, in the schedule's time
 *                       zone) + slack
 *
 * Today's own run is never required (no race with a late-ending run); the
 * slack (default 12h) absorbs a launchd-deferred start or GitHub cron delay.
 *
 * Expected table for a Mon-Fri schedule (12h slack):
 *   Mon 84 · Tue 36 · Wed 36 · Thu 36 · Fri 36 · Sat 36 · Sun 60
 *
 * The weekday comes from Intl.DateTimeFormat in the named zone, never from
 * manual UTC-offset arithmetic, so DST is irrelevant.
 */

/** ISO weekday numbers: 1 = Monday .. 7 = Sunday. */
export const MON_FRI = [1, 2, 3, 4, 5] as const;

export interface ScheduleBudgetOptions {
  /** IANA zone the schedule's weekdays are defined in. */
  timeZone: string;
  /** Scheduled ISO weekdays (1 = Mon .. 7 = Sun). */
  weekdays: readonly number[];
  /** Hours added on top of the day gap. Defaults to 12. */
  slackHours?: number;
}

const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function isoWeekdayIn(now: Date, timeZone: string): number {
  const short = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(now);
  const day = ISO_WEEKDAY[short];
  if (day === undefined) {
    throw new Error(`schedule-budget: unexpected weekday "${short}" for zone ${timeZone}`);
  }
  return day;
}

export function dayAwareStaleHours(now: Date, opts: ScheduleBudgetOptions): number {
  const { timeZone, weekdays, slackHours = 12 } = opts;
  if (weekdays.length === 0) {
    throw new Error("schedule-budget: weekdays must not be empty");
  }
  for (const d of weekdays) {
    if (!Number.isInteger(d) || d < 1 || d > 7) {
      throw new Error(`schedule-budget: weekday ${d} is outside 1 (Mon) .. 7 (Sun)`);
    }
  }
  const scheduled = new Set(weekdays);
  const today = isoWeekdayIn(now, timeZone);
  for (let back = 1; back <= 7; back += 1) {
    const day = ((today - 1 - back) % 7 + 7) % 7 + 1;
    if (scheduled.has(day)) {
      return 24 * back + slackHours;
    }
  }
  /* c8 ignore next -- unreachable: a non-empty valid set always matches within 7 days */
  throw new Error("schedule-budget: no scheduled weekday found");
}
