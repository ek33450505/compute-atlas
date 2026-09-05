/**
 * Read-only freshness check for the `discovery_heartbeat` singleton row.
 *
 * Why this exists: the discovery pipeline runs on the maintainer's Mac via
 * launchd at 13:00 local. `macOS StartCalendarInterval` does NOT catch up a
 * missed run — if the machine is asleep/off at 13:00, the run simply never
 * happens, and nothing on that machine errors (there's nothing there to error
 * — the job never fired). `scripts/discovery/run.sh:72-98` documents this gap
 * and has a *local* partial mitigation (a same-machine stale check that only
 * fires the NEXT time the machine happens to be awake and run.sh happens to
 * run). This script is the off-machine complement, meant to be invoked from
 * GitHub Actions on its own schedule so a missed run is detected even if the
 * Mac stays asleep indefinitely.
 *
 * Unlike `scripts/check-neon-drift.ts` (deliberately non-blocking, always
 * exits 0), and much like `scripts/check-schema-drift.ts`, this script FAILS
 * CLOSED on purpose:
 *   - DATABASE_URL unset                                  -> exit 1
 *   - DISCOVERY_STALE_HOURS set but unparseable            -> exit 1
 *   - no discovery_heartbeat row exists                    -> exit 1
 *   - last_run_at older than the threshold                 -> exit 1
 * A monitor that silently passes when it cannot check, or when the thing it
 * is meant to detect (silence) has in fact occurred, is worse than no monitor
 * — that is the exact gap this script exists to close.
 *
 * Scope boundary (deliberately narrow): this script checks FRESHNESS only —
 * "did a discovery run happen recently at all". It does NOT re-judge run
 * *quality* (a "degraded" status still exits 0 here, with a warning printed);
 * `run.sh` already alerts locally for degraded runs via `notify()`. Do not
 * widen this script to duplicate that — it would create two sources of truth
 * for the same signal, and the whole reason the watchdog runs off-machine is
 * to catch the one failure mode `run.sh` structurally cannot: itself never
 * running.
 *
 * Run: npm run check:heartbeat (local, reads .env.local)
 * Or:  npx tsx scripts/discovery/check-heartbeat.ts (CI, reads DATABASE_URL from env)
 *
 * Uses relative imports, matching the other scripts in this folder.
 */
import { eq } from "drizzle-orm";

import { getDb, hasDatabaseUrl } from "../../lib/db/client";
import { discoveryHeartbeatTable, type DiscoveryHeartbeatRow } from "../../lib/db/schema";

// --- threshold -----------------------------------------------------------

/**
 * Deliberately matches the same-named `DISCOVERY_STALE_HOURS` default in
 * `scripts/discovery/run.sh` (`DISCOVERY_STALE_HOURS="${DISCOVERY_STALE_HOURS:-36}"`)
 * so the local (on-machine, same-run) check and this remote (off-machine,
 * scheduled) check agree on what "stale" means. Keep these two literals in
 * sync if either changes.
 */
export const DISCOVERY_STALE_HOURS_DEFAULT = 36;

/**
 * Parses `DISCOVERY_STALE_HOURS` from the environment. An unset/empty value
 * falls back to `DISCOVERY_STALE_HOURS_DEFAULT`. A value that IS present but
 * fails to parse as a positive number THROWS rather than silently falling
 * back — an unparseable limit that disables its own bound is a known trap in
 * this repo (see `scripts/discovery/run.sh`'s and `extract-fields.ts`'s
 * `ENRICHMENT_LIMIT`/`VERIFY_LIMIT` validation for the same precaution).
 */
export function parseStaleHoursEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return DISCOVERY_STALE_HOURS_DEFAULT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `check-heartbeat: DISCOVERY_STALE_HOURS="${raw}" is not a valid positive number of hours. ` +
        `Refusing to silently fall back to the default (${DISCOVERY_STALE_HOURS_DEFAULT}h) — an ` +
        "unparseable threshold that disables the bound is exactly the failure mode this repo has " +
        "hit before (see run.sh's ENRICHMENT_LIMIT/VERIFY_LIMIT validation)."
    );
  }
  return parsed;
}

// --- read ------------------------------------------------------------------

/** Reads the single `discovery_heartbeat` row (id="singleton"), or null if it does not exist yet. */
export async function fetchHeartbeatRow(): Promise<DiscoveryHeartbeatRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(discoveryHeartbeatTable)
    .where(eq(discoveryHeartbeatTable.id, "singleton"));
  return rows[0] ?? null;
}

// --- report + errors ---------------------------------------------------

export interface HeartbeatFreshnessReport {
  row: DiscoveryHeartbeatRow;
  ageHours: number;
  thresholdHours: number;
  isDegraded: boolean;
}

/**
 * Thrown when no `discovery_heartbeat` row exists at all. This is expected
 * ONLY before the very first run after this feature's own deploy — any other
 * time, it means the publisher (`scripts/discovery/publish-heartbeat.ts`) is
 * broken. A missing row must never be read as "fine": that would be a
 * fail-open, and this whole feature exists because a silent instrument is
 * not monitoring.
 */
export class HeartbeatMissingError extends Error {
  constructor() {
    super(
      "No discovery_heartbeat row found. This means EITHER no discovery run has ever published a " +
        "heartbeat (expected only before the first run after this feature's deploy), OR the " +
        "publisher (scripts/discovery/publish-heartbeat.ts) is broken. Treating a missing row as " +
        '"fine" would be a fail-open — this check exists specifically because a silent instrument ' +
        "is not monitoring."
    );
    this.name = "HeartbeatMissingError";
  }
}

/** Thrown when `last_run_at` is older than the configured threshold. */
export class HeartbeatStaleError extends Error {
  readonly report: HeartbeatFreshnessReport;

  constructor(report: HeartbeatFreshnessReport) {
    super(
      `discovery_heartbeat is stale: last run ${report.ageHours.toFixed(1)}h ago ` +
        `(threshold ${report.thresholdHours}h), recorded status="${report.row.status}". Scheduled ` +
        "discovery runs were likely missed entirely (macOS StartCalendarInterval does not catch up " +
        "a missed run)."
    );
    this.name = "HeartbeatStaleError";
    this.report = report;
  }
}

/**
 * Runs the freshness check against whatever `getDb()` currently resolves to.
 * Throws `HeartbeatMissingError` when no row exists, or `HeartbeatStaleError`
 * when the row is older than `thresholdHours`. Returns the report (which may
 * still describe a "degraded" recorded status — see the scope-boundary note
 * in the module doc comment) when the row is fresh.
 */
export async function runHeartbeatCheck(
  thresholdHours: number = parseStaleHoursEnv(process.env.DISCOVERY_STALE_HOURS),
  now: Date = new Date()
): Promise<HeartbeatFreshnessReport> {
  const row = await fetchHeartbeatRow();
  if (!row) {
    throw new HeartbeatMissingError();
  }

  const ageHours = (now.getTime() - new Date(row.lastRunAt).getTime()) / (1000 * 60 * 60);
  const report: HeartbeatFreshnessReport = {
    row,
    ageHours,
    thresholdHours,
    isDegraded: row.status !== "ok",
  };

  if (ageHours > thresholdHours) {
    throw new HeartbeatStaleError(report);
  }

  return report;
}

// --- CLI ---------------------------------------------------------------

function printFresh(report: HeartbeatFreshnessReport): void {
  console.log(
    `✓ discovery_heartbeat is fresh: last run ${report.ageHours.toFixed(1)}h ago ` +
      `(threshold ${report.thresholdHours}h), recorded status="${report.row.status}".`
  );
  if (report.isDegraded) {
    console.log(
      `::warning::discovery_heartbeat's recorded status is "${report.row.status}" (not "ok"). This ` +
        "script checks FRESHNESS only — whether the pipeline ran at all — not run quality; run.sh " +
        "already alerts locally for degraded runs. This warning does not fail the check."
    );
  }
}

async function main(): Promise<void> {
  // Fail CLOSED — an unconfigured database is a failure to verify, not a
  // skip. Same posture as check-schema-drift.ts, deliberately the opposite
  // of check-neon-drift.ts's graceful exit-0.
  if (!hasDatabaseUrl()) {
    console.error(
      "::error::DATABASE_URL is not set. Configure it in .env.local (see .env.example) for a local " +
        "run, or as a secret for the scheduled CI run. This check fails closed rather than skipping."
    );
    process.exit(1);
    return;
  }

  let thresholdHours: number;
  try {
    thresholdHours = parseStaleHoursEnv(process.env.DISCOVERY_STALE_HOURS);
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  try {
    const report = await runHeartbeatCheck(thresholdHours);
    printFresh(report);
    process.exit(0);
  } catch (err) {
    if (err instanceof HeartbeatMissingError || err instanceof HeartbeatStaleError) {
      console.error(`::error::${err.message}`);
      process.exit(1);
      return;
    }
    // Log only the message (not the raw error object) so a Neon/pg connection
    // error can't echo the DB host/DSN into this public repo's Actions logs —
    // same precaution as check-neon-drift.ts / check-schema-drift.ts.
    console.error(
      "::error::heartbeat freshness check errored:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  }
}

// Only run the CLI when this file is executed directly, not when its exports
// are imported by the test suite — matches the isMain guard used across this
// directory's other check-*/publish-*.ts scripts.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
