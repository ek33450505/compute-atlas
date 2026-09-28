/**
 * Read-only health check for the `discovery_heartbeat` singleton row.
 *
 * Why this exists: the discovery pipeline runs on the maintainer's Mac via
 * launchd at 13:00 local. `macOS StartCalendarInterval` does NOT catch up a
 * missed run — if the machine is asleep/off at 13:00, the run simply never
 * happens, and nothing on that machine errors (there's nothing there to error
 * — the job never fired). The "RESIDUAL GAP" note in the alerting section of
 * `scripts/discovery/run.sh` documents this gap
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
 *   - recorded status is not "ok" (it ran, and it failed)  -> exit 1
 * A monitor that silently passes when it cannot check, or when the thing it
 * is meant to detect (silence) has in fact occurred, is worse than no monitor
 * — that is the exact gap this script exists to close.
 *
 * SCOPE — WIDENED 2026-09-28 from liveness to liveness AND run quality.
 * This script used to check FRESHNESS only ("did a run happen at all"), and a
 * fresh-but-"degraded" row exited 0 with a printed warning. The stated reason
 * was that `run.sh` already alerted locally for degraded runs via `notify()`,
 * so failing here would duplicate that signal. That premise was false, and it
 * cost three days:
 *
 *   2026-09-26 (WI, IN)  73-byte output  "Failed to authenticate: OAuth session expired"
 *   2026-09-27 (OK, WY)  73-byte output  same
 *   2026-09-28 (NM, LA)   0-byte output  `claude` not on the launchd PATH
 *
 * Every one of those runs published a perfectly FRESH heartbeat
 * (`{"status":"degraded","failureCount":2}`), so this check passed and the
 * Discovery Watchdog workflow reported `success` all three days. A pipeline
 * that runs daily and fails daily is maximally fresh — freshness alone cannot
 * see it. The outage was found by a human noticing an absence of results, not
 * by any instrument.
 *
 * The local-notification premise is not repairable by trusting it harder.
 * Through those three days `notify()` was `terminal-notifier ... >/dev/null
 * 2>&1 || true`, additionally gated on `DISCOVERY_NOTIFY`, i.e. fire-and-forget
 * with no record of whether anything was ever attempted — which is why, after
 * the outage, nobody could say whether a single notification had fired.
 * `notify()` in `scripts/discovery/run.sh` was made legible on
 * 2026-09-28: it captures each notifier's status with `|| rc=$?` and logs
 * suppressed / no-notifier / dispatched / failed for every call. That answers
 * "was one dispatched", not "did anyone see it" — a notifier exits 0 with the
 * banner swallowed by Focus, Do Not Disturb or a revoked permission — so the
 * local signal is still not coverage, and this off-machine check owns both
 * questions.
 *
 * Liveness and quality stay DISTINGUISHABLE in the output (`HeartbeatStaleError`
 * vs `HeartbeatDegradedError`) because their remedies share nothing: a stale
 * row means launchd never fired and the fix is on the schedule/machine; a
 * degraded row means the run executed and failed, and the fix is in the run's
 * own logs on that Mac.
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
  /**
   * `row.status !== "ok"`. On a report RETURNED by `runHeartbeatCheck` this is
   * always `false`: since 2026-09-28 a degraded row throws rather than being
   * handed back with a flag set. It stays on the interface because the thrown
   * errors carry a report too, and there it is load-bearing — a stale row can
   * ALSO be degraded, and `HeartbeatStaleError.report.isDegraded` is the only
   * place that pairing is visible.
   */
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

/**
 * Thrown when `last_run_at` is older than the configured threshold — i.e. NO
 * run happened. Deliberately a different type from `HeartbeatDegradedError`:
 * this one points at the schedule/machine, that one points at the run's logs.
 */
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
 * Thrown when the row is FRESH but its recorded status is not "ok" — i.e. a
 * run happened and failed. Added 2026-09-28 after three consecutive failed
 * runs (2026-09-26..28) each published a fresh degraded heartbeat and this
 * check passed all three; see the SCOPE note in the module doc comment.
 */
export class HeartbeatDegradedError extends Error {
  readonly report: HeartbeatFreshnessReport;

  constructor(report: HeartbeatFreshnessReport) {
    super(
      `discovery_heartbeat is FRESH but DEGRADED: a run finished ${report.ageHours.toFixed(1)}h ` +
        `ago (threshold ${report.thresholdHours}h) and recorded status="${report.row.status}" ` +
        `with failureCount=${report.row.failureCount}. This is NOT a missed run — launchd fired ` +
        "and run.sh executed; the run itself failed, so look in that run's own output on the " +
        "maintainer's Mac (discovery-logs/, gitignored and never leaves that machine) rather than " +
        "at the schedule. Real causes so far: an expired Claude Code OAuth session (2026-09-26/27) " +
        "and `claude` missing from the launchd PATH (2026-09-28). Do not rely on run.sh's local " +
        "notify() having told anyone — it is fire-and-forget and leaves no record of delivery."
    );
    this.name = "HeartbeatDegradedError";
    this.report = report;
  }
}

/**
 * Runs the health check against whatever `getDb()` currently resolves to.
 * Throws on every condition that should fail the check: `HeartbeatMissingError`
 * when no row exists, `HeartbeatStaleError` when the row is older than
 * `thresholdHours`, and `HeartbeatDegradedError` when a fresh row records a
 * status other than "ok". Returns a report ONLY when the pipeline both ran
 * recently and ran successfully.
 *
 * The degraded failure lives HERE rather than in the CLI layer on purpose
 * (2026-09-28). Keeping all three failures in one place makes the contract
 * "returns iff the check passed"; if the degraded case were a flag on the
 * return value for callers to interpret, a caller that simply did not look
 * would fail open — which is precisely the defect being fixed, since the CLI
 * DID look at `isDegraded` and chose to pass anyway.
 *
 * Staleness is evaluated BEFORE degradedness: a stale row's recorded status is
 * itself stale information, and "it stopped running" is the more urgent
 * finding. Nothing is lost by the ordering — `HeartbeatStaleError`'s message
 * echoes the recorded status and its report keeps `isDegraded`.
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

  if (report.isDegraded) {
    throw new HeartbeatDegradedError(report);
  }

  return report;
}

// --- CLI ---------------------------------------------------------------

function printHealthy(report: HeartbeatFreshnessReport): void {
  console.log(
    `✓ discovery_heartbeat is fresh AND healthy: last run ${report.ageHours.toFixed(1)}h ago ` +
      `(threshold ${report.thresholdHours}h), recorded status="${report.row.status}".`
  );
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
    printHealthy(report);
    process.exit(0);
  } catch (err) {
    if (
      err instanceof HeartbeatMissingError ||
      err instanceof HeartbeatStaleError ||
      err instanceof HeartbeatDegradedError
    ) {
      console.error(`::error::${err.message}`);
      process.exit(1);
      return;
    }
    // Log only the message (not the raw error object) so a Neon/pg connection
    // error can't echo the DB host/DSN into this public repo's Actions logs —
    // same precaution as check-neon-drift.ts / check-schema-drift.ts.
    console.error(
      "::error::heartbeat health check errored:",
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
