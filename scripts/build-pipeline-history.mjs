#!/usr/bin/env node
/**
 * build-pipeline-history.mjs
 *
 * Build-time generator for the homepage's time axis: for each quarter, how
 * many tracked facilities STOOD IN each status at that quarter's end.
 *
 * Output (committed): public/data/pipeline-history.json
 *
 * ⚠️ EVERY FIGURE IN THIS COMMENT IS ILLUSTRATIVE AT A GIVEN DATASET SIZE, not
 * a maintained constant. They are quoted at 1,956 facilities / 1,557 dated
 * events (the 2026-09-15 wave) to make the reasoning concrete, and EVERY ONE
 * of them drifts on the next `db:sync`. A consumer must READ these quantities
 * off `public/data/pipeline-history.json` — `coverage`, and
 * `coverage.ambiguousPeak` in particular — never copy a literal out of here.
 * The figures below were last recomputed against that artifact on 2026-09-15;
 * a wave that moves the dataset silently falsifies them again, which has now
 * happened once (the peak's denominator was quoted as 373 after it had become
 * 386).
 *
 * ── Why composition, not arrival rate ────────────────────────────────────────
 * The raw event curve (1,557 status events — 2022: 46 · 2023: 56 · 2024: 155 ·
 * 2025: 409 · 2026: 775) substantially measures when Compute Atlas RECORDED
 * things, not when they happened. Shipping that as "the buildout accelerating"
 * would be precisely the error this site exists to criticise. So this artifact
 * is a STATE RECONSTRUCTION — a standing count per status at each quarter end —
 * never an event tally.
 *
 * ── The honesty problem composition does NOT solve ───────────────────────────
 * Only 1,142 of 1,956 facilities carry any `statusHistory`, and a facility's
 * status is only knowable from its first recorded event onward. So the
 * population the series describes GROWS: 160 facilities at 2023Q1 against
 * 1,142 today. A share can therefore shift purely because newly-tracked
 * records skew toward `proposed`. Normalising to 100% here would hide that.
 * Hence: emit COUNTS, never percentages, and carry `known` (the denominator)
 * per quarter plus `coverage` metadata, so the consumer can render the
 * denominator visibly and caption what the population actually is.
 *
 * ── Reconstruction rules ─────────────────────────────────────────────────────
 * 1. A facility's status at the end of quarter Q is the status of its LATEST
 *    `statusHistory` entry dated on or before Q's last day.
 * 2. A facility with NO `statusHistory` is EXCLUDED from every quarter. It is
 *    never backfilled from its current `status`: asserting it held that status
 *    in the past is exactly the fabrication this artifact exists to avoid.
 *    The count is published as `coverage.excludedNoHistory` so the consumer
 *    can disclose it.
 * 3. A facility is ABSENT from every quarter before its first event — not
 *    counted as anything, never carried backward.
 * 4. A facility IS carried FORWARD past its last event to the present: a status
 *    persists until something changes it, and dropping it would make the
 *    denominator fall for facilities nothing happened to. `cancelled`
 *    facilities keep occupying the composition for the same reason — evicting
 *    them would silently re-normalise the mix and read as growth.
 * 5. Partial dates (`YYYY`, `YYYY-MM` — 251 and 592 of the 1,557 events) are
 *    resolved to the START of the period they name. The alternative, resolving
 *    to the period's end, sounds more conservative but concentrates every
 *    year-only event onto a Q4 boundary, producing a fake annual sawtooth in
 *    the denominator of a chart whose entire subject is change over time. That
 *    is the worse distortion, so start-of-period stands — but it is NOT the
 *    neutral choice, and the direction of its bias must be stated wherever
 *    this series is captioned:
 *
 *      Start-of-period makes every imprecisely-dated transition appear EARLIER
 *      than the source pins it. The series therefore reads as an EARLIER,
 *      FASTER buildout than the sources support. That is the same distortion
 *      this artifact exists to avoid, reintroduced one layer down, so it is
 *      disclosed as data rather than left to a comment.
 *
 *    The two precisions do NOT contribute equally, and it is worth being exact
 *    about why, because the obvious paraphrase ("year-only shifts by up to 3
 *    quarters, month-only by up to 1") is wrong on the second half:
 *      · YEAR-only (251 events) is the whole story. `"2026"` reads as 2026Q1
 *        when the source admits anything up to 2026Q4 — a 3-quarter shift, and
 *        3 is the measured maximum across the dataset.
 *      · MONTH-only (592 events) shifts by at most ~30 days, and a month nests
 *        entirely INSIDE a quarter, so it can never move a transition across a
 *        quarter boundary at all. It still contributes, but only by REORDERING
 *        two events that fall in the same quarter, which changes the status
 *        shown at that quarter's end. Measured over the whole series: 21
 *        facility-quarters GAIN the ambiguous flag from month imprecision and
 *        6 LOSE it, for a net of 15. It is a net, not a count — reordering can
 *        resolve an ambiguity as readily as create one. At the worst quarter
 *        the contribution is exactly 1 of the 52 (1 gained, 0 lost).
 *        ⚠️ Unlike every other figure in this header, this 21/6/15 split is
 *        NOT recoverable from the emitted artifact — it needs the script run
 *        twice under both date readings — so it was NOT recomputed in the
 *        2026-09-15 pass and still describes an earlier dataset. Treat the
 *        DIRECTION (month imprecision is a small net contributor) as the
 *        claim; re-measure before quoting the magnitudes.
 *
 *    `coverage.datePrecision` discloses only how coarse the dates are, which
 *    says nothing about direction or magnitude. The magnitude is therefore
 *    emitted per quarter as `ambiguous` (below) and peaked in
 *    `coverage.ambiguousPeak`: at the worst quarter, 2025Q1, 52 of 386 known
 *    facilities (13.47%) sit in a row this choice moves.
 *
 *    `ambiguous` is a PARTITION, not a union. Every flagged facility took
 *    exactly one of the two branches below, so the parts sum to the whole and
 *    a caption that splits the figure reconciles. Both parts are emitted per
 *    quarter, so a caption reads them off the artifact instead of off this
 *    comment:
 *      · `ambiguousEntry` — `admissible === null`. The facility is in the
 *        denominator under start-of-period, but under the LATEST reading its
 *        sources admit it has not entered yet, so its presence is unsupported.
 *        At 2025Q1: 36 of 386 (9.33%).
 *      · `ambiguousStatus` — `admissible !== null && admissible !== status`.
 *        Present under both readings, but shown in a STATUS the sources do not
 *        pin to this quarter. At 2025Q1: 16 of 386 (4.15%).
 *    36 + 16 = 52, and 9.33% + 4.15% = 13.48%, which `ambiguousPeak.share`
 *    rounds to the 13.5% a caption is likely to print. Split it at TWO
 *    decimals: 9.3% + 4.1% is 13.4%, which does not reconcile against the
 *    13.5% sitting next to it.
 *
 *    Two earlier revisions of this comment carried figures that do NOT come
 *    from those branches: a `≤5.2%` peak, and a 9.9% / 12.3% pair described as
 *    two overlapping readings whose union is `ambiguous`. Neither member of
 *    that pair is a quantity this code computes, so the split it invites
 *    cannot be checked against the artifact — which is exactly the failure.
 *    Do not restore either. Take the split from `ambiguousEntry` /
 *    `ambiguousStatus`, which are computed per quarter rather than copied.
 *
 *    Start-of-period is also what a plain lexicographic comparison of these
 *    strings yields, so anyone recomputing this independently gets the same
 *    numbers.
 *
 * ── Window ───────────────────────────────────────────────────────────────────
 * Events run back to 1970; the denominator before 2020 is double digits, which
 * is noise, not a series. The quarter AXIS is therefore windowed to
 * `START_QUARTER` (see below) — but the POPULATION is not: every event on or
 * before a quarter's end counts toward it, including events predating the
 * window. Windowing here rather than in the component keeps the honesty
 * decision next to the data, and `coverage.earliestEvent` /
 * `coverage.quartersOmitted` record what the axis does not show, so the
 * consumer cannot silently imply coverage the data lacks.
 *
 * ── Freshness ────────────────────────────────────────────────────────────────
 * `public/data/` is served under `/data/:path+` with
 * `s-maxage=86400, stale-while-revalidate=604800` (next.config.ts), so a
 * regenerated artifact can sit behind the edge cache for up to a day plus a
 * week of stale reuse. If the consumer FETCHES it client-side, a correction
 * needs a Cloudflare purge (purge-by-URL does not work on this plan — only
 * `purge_everything`). If the consumer IMPORTS it at build time instead, the
 * edge cache is irrelevant and it ships with the deploy.
 *
 * Runs as part of `npm run build:mapdata` (including under --skip-nhd, since
 * it does no network I/O) and standalone via `npm run build:pipelinehistory`.
 *
 * Usage: node scripts/build-pipeline-history.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const FACILITIES_PATH = resolve(repoRoot, 'data/facilities.json');
const META_PATH = resolve(repoRoot, 'data/facilities.meta.json');
const OUT_PATH = resolve(repoRoot, 'public/data/pipeline-history.json');

/**
 * The five `Status` values, in `lib/status.ts`'s STATUS_ORDER. Duplicated here
 * rather than imported because this is a plain .mjs build script and
 * lib/status.ts pulls in lucide-react — the same tradeoff build-hero-plate.mjs
 * makes. Drift is caught by the STATUS_ORDER equality test in
 * build-pipeline-history.test.ts, which imports lib/status.ts directly.
 *
 * Order is load-bearing: it is the stacking order the chart paints in.
 */
export const STATUS_ORDER = [
  'operational',
  'under_construction',
  'permitted',
  'proposed',
  'cancelled',
];

/**
 * First quarter on the axis. A FIXED constant, not derived from the data: a
 * data-derived start (e.g. "first quarter where n >= 10% of today's n") would
 * slide the x-axis on every publish, so the same chart would show a different
 * span week to week. 2020Q1 gives ~27 quarters through 2026Q3 — close to the
 * ~28 the design assumed — and grows forward naturally as time passes.
 */
export const START_QUARTER = { year: 2020, quarter: 1 };

/**
 * Matches EXACTLY `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` — anchored at BOTH ends,
 * with the day admissible only behind a month. The `$` and the nesting are
 * load-bearing: unanchored, this pattern matched the leading `2025` of both
 * `"20250915"` and `"2025-9"` and filed them as YEAR precision, silently
 * placing a September event on January 1st — 8 months early, and invisible
 * because it looks like an ordinary year-only date downstream.
 *
 * All 1,557 events in today's `data/facilities.json` are already one of the
 * three exact shapes (checked: 714 day, 592 month, 251 year), so anchoring
 * rejects nothing that exists — it closes the door on the next bad import.
 */
const DATE_SHAPE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Days in month `month` (1-12) of `year`. Day 0 of the NEXT month is this one's last. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolve a `statusHistory` date to the period it names: `day` is the START of
 * that period (see reconstruction rule 5 for why start-of-period) and
 * `periodEnd` its LAST day. The two are equal for a full `YYYY-MM-DD`.
 *
 * `periodEnd` is what makes rule 5's distortion measurable rather than merely
 * asserted: it is the LATEST resolution the source admits, so reconstructing
 * against it and diffing gives the exact set of facilities whose row this
 * choice moves (see `ambiguous`).
 *
 * The month and day are RANGE-checked, not just shape-checked. A bare `\d{2}`
 * accepted `"2024-13-01"` and `"2025-02-31"`; month 13 then walked through
 * `quarterOf`'s arithmetic into quarter 5, emitting a `2026Q5` row with an
 * `end` of `2027-03-31` — a nonsense quarter on a chart, from data that
 * tripped no guard anywhere.
 *
 * @returns {{ day: string, periodEnd: string, precision: 'year'|'month'|'day' } | null}
 *   null when the string is not one of the three exact shapes or names a
 *   month/day that does not exist. Such an event cannot be placed on a time
 *   axis at all, so it is dropped and counted in `coverage.unparseableDates`
 *   — never coerced into a plausible-looking wrong date.
 */
export function resolveEventDate(raw) {
  if (typeof raw !== 'string') return null;
  const m = DATE_SHAPE.exec(raw.trim());
  if (!m) return null;
  const [, year, month, day] = m;
  if (month === undefined) {
    return { day: `${year}-01-01`, periodEnd: `${year}-12-31`, precision: 'year' };
  }
  const monthNum = Number(month);
  if (monthNum < 1 || monthNum > 12) return null;
  const lastDay = daysInMonth(Number(year), monthNum);
  if (day === undefined) {
    return {
      day: `${year}-${month}-01`,
      periodEnd: `${year}-${month}-${String(lastDay).padStart(2, '0')}`,
      precision: 'month',
    };
  }
  const dayNum = Number(day);
  if (dayNum < 1 || dayNum > lastDay) return null;
  const exact = `${year}-${month}-${day}`;
  return { day: exact, periodEnd: exact, precision: 'day' };
}

/** Last day of quarter `q` (1-4) of `year`, as ISO `YYYY-MM-DD`. */
export function quarterEnd(year, quarter) {
  // Day 0 of the month AFTER the quarter's last month is that month's last day.
  const d = new Date(Date.UTC(year, quarter * 3, 0));
  return d.toISOString().slice(0, 10);
}

/** `{ year, quarter }` containing an ISO `YYYY-MM-DD` day. */
export function quarterOf(day) {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return { year, quarter: Math.floor((month - 1) / 3) + 1 };
}

/** Inclusive list of `{ year, quarter }` from `from` to `to`. */
export function quarterRange(from, to) {
  const out = [];
  let { year, quarter } = from;
  while (year < to.year || (year === to.year && quarter <= to.quarter)) {
    out.push({ year, quarter });
    quarter += 1;
    if (quarter > 4) {
      quarter = 1;
      year += 1;
    }
  }
  return out;
}

/**
 * Reconstruct the per-quarter status composition.
 *
 * Pure — no I/O — so tests drive it with fixtures rather than the live
 * dataset, which changes every data wave.
 *
 * @param {Array<object>} facilities  `data/facilities.json` shape.
 * @param {object} [options]
 * @param {string} [options.asOf]     ISO instant of the snapshot; its quarter
 *   is the last one emitted, and the one flagged `partial` if still in progress.
 *   Defaults to the latest resolvable event.
 * @param {{year:number,quarter:number}} [options.startQuarter]
 * @returns {object} the artifact (see the JSDoc on `buildPipelineHistory`).
 */
export function buildPipelineHistoryData(facilities, options = {}) {
  if (!Array.isArray(facilities)) {
    throw new Error(
      `build-pipeline-history: expected an array of facilities, got ${typeof facilities}`
    );
  }

  const startQuarter = options.startQuarter ?? START_QUARTER;
  const datePrecision = { year: 0, month: 0, day: 0 };
  let unparseableDates = 0;

  // Rule 2: a facility with no usable event is excluded outright. `timelines`
  // holds only facilities we can actually place on a time axis.
  const timelines = [];
  let excludedNoHistory = 0;

  for (const facility of facilities) {
    const history = Array.isArray(facility?.statusHistory) ? facility.statusHistory : [];
    const events = [];
    history.forEach((event, index) => {
      const resolved = resolveEventDate(event?.date);
      if (!resolved) {
        unparseableDates += 1;
        return;
      }
      if (!STATUS_ORDER.includes(event?.status)) return;
      datePrecision[resolved.precision] += 1;
      events.push({
        day: resolved.day,
        periodEnd: resolved.periodEnd,
        status: event.status,
        index,
      });
    });

    if (events.length === 0) {
      excludedNoHistory += 1;
      continue;
    }

    // Ascending by resolved day; original array order breaks ties, so two
    // events resolving to the SAME day keep the curator's ordering — the later
    // one in the array wins the quarter. That tie-break is a decision, not an
    // artefact: reversing it moves the captioned peak by over a percentage
    // point, so it is pinned by a test rather than only asserted here.
    events.sort((a, b) => (a.day === b.day ? a.index - b.index : a.day < b.day ? -1 : 1));

    // Rule 5's counterfactual: the SAME events ordered by the LATEST day each
    // source admits. Reconstructing both and diffing per quarter is what turns
    // "start-of-period biases the series earlier" from an assertion into the
    // measured `ambiguous` count. Sorted once here, not once per quarter.
    // Same curator-order tie-break as above, and equally load-bearing: it moves
    // `ambiguous` without moving a single bar, so it is separately pinned.
    const latest = [...events].sort((a, b) =>
      a.periodEnd === b.periodEnd ? a.index - b.index : a.periodEnd < b.periodEnd ? -1 : 1
    );
    timelines.push({ events, latest });
  }

  const allDays = timelines.flatMap(({ events }) => events.map((e) => e.day)).sort();
  const earliestEvent = allDays[0] ?? null;
  const latestEvent = allDays[allDays.length - 1] ?? null;

  const asOf = options.asOf ?? null;
  const asOfDay = asOf ? asOf.slice(0, 10) : latestEvent;

  const quarters = [];
  let knownAtStart = 0;
  let quartersOmitted = 0;

  if (asOfDay && earliestEvent) {
    const firstDataQuarter = quarterOf(earliestEvent);
    const lastQuarter = quarterOf(asOfDay);
    const axisStart =
      firstDataQuarter.year > startQuarter.year ||
      (firstDataQuarter.year === startQuarter.year &&
        firstDataQuarter.quarter > startQuarter.quarter)
        ? firstDataQuarter
        : startQuarter;
    quartersOmitted = quarterRange(firstDataQuarter, axisStart).length - 1;

    for (const { year, quarter } of quarterRange(axisStart, lastQuarter)) {
      const end = quarterEnd(year, quarter);
      const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
      let known = 0;
      // `ambiguous` and its two disjoint causes. Emitted separately because a
      // caption that splits the headline figure has to reconcile against it,
      // and a split derived from a literal in a comment is how the retired
      // `≤5.2%` and `9.9%/12.3%` figures got here.
      let ambiguous = 0;
      let ambiguousEntry = 0;
      let ambiguousStatus = 0;

      for (const { events, latest } of timelines) {
        // Rule 1 + rules 3/4: the latest event on or before `end`. None yet =>
        // absent (rule 3); no later event => it simply stays (rule 4).
        let status = null;
        for (const event of events) {
          if (event.day > end) break;
          status = event.status;
        }
        if (status === null) continue;
        counts[status] += 1;
        known += 1;

        // Rule 5's magnitude, measured rather than asserted: replay the same
        // facility against the LATEST resolution each source admits. Start- and
        // end-of-period are the two extremes, so any admissible reading lies
        // between them — a facility that lands identically under both is PINNED
        // by its sources at this quarter, and one that does not is not.
        // `null` (not yet present) counts as a difference: an unsupported entry
        // into the denominator is as much a distortion as a wrong status.
        let admissible = null;
        for (const event of latest) {
          if (event.periodEnd > end) break;
          admissible = event.status;
        }
        if (admissible !== status) {
          ambiguous += 1;
          if (admissible === null) ambiguousEntry += 1;
          else ambiguousStatus += 1;
        }
      }

      const row = {
        quarter: `${year}Q${quarter}`,
        end,
        known,
        ambiguous,
        ambiguousEntry,
        ambiguousStatus,
        counts,
      };
      // The in-progress quarter is a legitimate "state as of today" reading,
      // but it is not a closed quarter — flag it so the chart can render the
      // last point as provisional rather than as a completed one. Strictly
      // `>`: a snapshot taken ON a quarter's last day sees that quarter CLOSED,
      // so it is not partial. `>=` would mislabel every quarter-end snapshot's
      // final point as provisional, and only a quarter-end `asOf` fixture can
      // tell the two apart.
      if (end > asOfDay) row.partial = true;
      quarters.push(row);
      if (quarters.length === 1) knownAtStart = known;
    }
  }

  return {
    asOf,
    statuses: [...STATUS_ORDER],
    coverage: {
      totalFacilities: facilities.length,
      withHistory: timelines.length,
      /**
       * Rule 2 — never backfilled from `facility.status`. Counts facilities
       * with NO usable event, which is almost entirely "no statusHistory at
       * all"; the rare "history present but unplaceable on a time axis" case
       * is surfaced separately by `unparseableDates`.
       */
      excludedNoHistory,
      earliestEvent,
      latestEvent,
      /** Closed quarters between `earliestEvent` and the axis start. */
      quartersOmitted,
      /** The denominator the axis opens on — the growth story starts here. */
      knownAtStart,
      /** Rule 5 — how imprecise the underlying dates are. */
      datePrecision,
      unparseableDates,
      /**
       * Rule 5 — the worst quarter's `ambiguous` share, so a caption can cite
       * the real peak without rescanning `quarters` (and without a literal
       * copied out of a comment drifting away from the data, which is exactly
       * how the retired `≤5.2%` figure got here). `share` is a percentage of
       * `known` at that quarter, rounded to one decimal; `entry` + `status` is
       * `count`, so a split caption reconciles. Ties resolve to the EARLIEST
       * quarter, so the value is stable across rebuilds.
       */
      ambiguousPeak: peakAmbiguous(quarters),
    },
    quarters,
  };
}

/**
 * The quarter with the highest `ambiguous` SHARE of its own denominator — not
 * the highest raw count, which would simply track the growing population and
 * always name the most recent quarter.
 *
 * Carries the `entry`/`status` partition through, so a caption splitting the
 * headline share never has to rescan `quarters` — the alternative is copying
 * the parts out of a comment, which is precisely how the retired figures got
 * into the header. `count` is `entry + status` by construction.
 *
 * @returns {{ quarter: string, count: number, entry: number, status: number,
 *   known: number, share: number } | null}
 */
export function peakAmbiguous(quarters) {
  let peak = null;
  for (const row of quarters) {
    if (row.known === 0) continue;
    const share = row.ambiguous / row.known;
    if (peak === null || share > peak.share) {
      peak = {
        quarter: row.quarter,
        count: row.ambiguous,
        entry: row.ambiguousEntry,
        status: row.ambiguousStatus,
        known: row.known,
        share,
      };
    }
  }
  if (peak === null) return null;
  return { ...peak, share: Math.round(peak.share * 1000) / 10 };
}

function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`build-pipeline-history: cannot read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`build-pipeline-history: ${path} is not valid JSON: ${err.message}`);
  }
}

/**
 * Guard: the snapshot instant the series declares it drew.
 *
 * Deliberately a near-duplicate of `build-hero-plate.mjs`'s export rather than
 * an import of it: the two are peer build scripts, not a library and its
 * consumer, and importing one from the other would make this artifact break
 * when that unrelated script is renamed. The cost is six lines; the benefit is
 * that the thrown message names the tool that actually failed.
 *
 * Exported so the guard is reachable from a test — an unexercised fail-loud
 * guard is indistinguishable from one that cannot fire.
 */
export function assertUsableAsOf(asOf, source = META_PATH) {
  if (typeof asOf !== 'string' || !ISO_INSTANT.test(asOf)) {
    throw new Error(
      `build-pipeline-history: ${source} has no usable \`asOf\` (${JSON.stringify(asOf)}) — the series must be able to state which snapshot it drew, and its last quarter is derived from that instant, so it must be an ISO-8601 instant like 2026-09-15T12:00:00.000Z`
    );
  }
  return asOf;
}

/**
 * Guard: an empty series would blank the chart with no error anywhere in the
 * build. `buildPipelineHistoryData` returns 0 quarters legitimately (it is a
 * pure function and an empty dataset is a valid input); it is only WRITING
 * that artifact that is refused.
 *
 * Exported so the guard is reachable from a test.
 */
export function assertHasQuarters(quarters) {
  if (quarters.length === 0) {
    throw new Error(
      `build-pipeline-history: produced 0 quarters from ${FACILITIES_PATH} — refusing to write an empty artifact that would blank the chart`
    );
  }
  return quarters;
}

/**
 * Guard: `known` is the denominator the chart divides by, so a drift between
 * it and the bars it is meant to total is a silent arithmetic lie. Catch it
 * here, not in review.
 *
 * Exported for the same reason as `assertUsableAsOf`: this invariant cannot be
 * violated by any fixture `buildPipelineHistoryData` accepts, so the only way
 * to prove the guard fires is to hand it a row that breaks it.
 */
export function assertReconciled(quarters) {
  for (const row of quarters) {
    const summed = STATUS_ORDER.reduce((sum, s) => sum + (row.counts[s] ?? 0), 0);
    if (summed !== row.known) {
      throw new Error(
        `build-pipeline-history: reconciliation failed at ${row.quarter} — status counts sum to ${summed} but known is ${row.known}`
      );
    }
  }
  return quarters;
}

/**
 * Read data/facilities.json + data/facilities.meta.json and write
 * public/data/pipeline-history.json.
 *
 * Fails loudly (throws) when the source is missing, unreadable, has no usable
 * `asOf`, or yields no quarters — a silently-empty artifact would blank the
 * chart with no error anywhere in the build.
 *
 * @returns {{ quarters: number, known: number, excluded: number, bytes: number, outPath: string }}
 */
export function buildPipelineHistory() {
  const facilities = readJson(FACILITIES_PATH);
  const meta = readJson(META_PATH);

  const asOf = assertUsableAsOf(meta?.asOf);

  const data = buildPipelineHistoryData(facilities, { asOf });

  assertHasQuarters(data.quarters);
  assertReconciled(data.quarters);

  const json = `${JSON.stringify(data, null, 2)}\n`;
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, json, 'utf8');

  const last = data.quarters[data.quarters.length - 1];
  return {
    quarters: data.quarters.length,
    known: last.known,
    excluded: data.coverage.excludedNoHistory,
    ambiguousPeak: data.coverage.ambiguousPeak,
    bytes: Buffer.byteLength(json),
    outPath: OUT_PATH,
  };
}

// Runnable directly: node scripts/build-pipeline-history.mjs
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const r = buildPipelineHistory();
    console.log(
      `pipeline-history: ${r.quarters} quarters, ${r.known} facilities known at the last quarter (${r.excluded} excluded for having no statusHistory) -> ${r.outPath.replace(`${repoRoot}/`, '')} (${(r.bytes / 1024).toFixed(1)} KB)`
    );
    // Printed every run so the rule-5 bias is visible to whoever regenerates
    // this, not only to whoever reads the JSON.
    if (r.ambiguousPeak) {
      const p = r.ambiguousPeak;
      console.log(
        `pipeline-history: rule 5 — imprecise dates bias transitions EARLIER; worst quarter ${p.quarter}, ${p.count}/${p.known} (${p.share}%) of the denominator sits in a row that choice moves`
      );
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
