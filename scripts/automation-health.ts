/**
 * Scheduled-workflow health check: fails LOUDLY when a scheduled GitHub
 * Actions workflow has stopped running, or has started failing, and posts
 * that as a GitHub issue.
 *
 * Why this exists (2026-09-09): `.github/workflows/drift-alert.yml` failed
 * six consecutive nightly runs (2026-09-03 .. 2026-09-08) and nobody
 * noticed. Root cause of the *non-noticing*, not of the failure itself:
 * scheduled-workflow failures have no reader. A normal CI failure gets seen
 * because it blocks a PR; a scheduled failure sends an email that gets
 * filtered. The maintainer works the backlog via `gh issue list`, so a
 * GitHub issue is the surface that actually reaches them.
 *
 * Second, related gap this closes: when `neon-sync.yml` finds no drift it
 * correctly opens no PR — so "no sync PR today" is indistinguishable from
 * "the sync chain is dead." Run *freshness* (not just conclusion)
 * disambiguates that, because the scheduled run still happens either way.
 * Freshness also catches GitHub auto-disabling a schedule after 60 days of
 * repo inactivity — that shows up here as `never-run`/`stale`, not silence.
 *
 * Fails CLOSED, like `scripts/check-schema-drift.ts` and unlike
 * `scripts/check-neon-drift.ts` (which is deliberately advisory): a missing
 * `GITHUB_TOKEN`, or any workflow found not-`ok`, exits 1. "Could not check"
 * must never read as "healthy" — that is the exact failure mode this script
 * exists to catch, one layer up.
 *
 * Run: npx tsx scripts/automation-health.ts [--out=<path>]
 * Reads GITHUB_TOKEN and GITHUB_REPOSITORY (owner/repo) from env, matching
 * the ambient vars a GitHub Actions job already provides.
 */
import { writeFileSync } from "node:fs";

export type WorkflowState = "ok" | "failing" | "stale" | "never-run";

/** One monitored workflow: which file, what schedule, how stale is too stale. */
export interface WorkflowConfig {
  file: string;
  name: string;
  /** Human-readable cron description, purely for the report — not parsed. */
  cronDescription: string;
  /** Hours since the newest run before we call it stale. */
  staleAfterHours: number;
}

/**
 * Monitored workflows and their freshness budgets. Crons verified on disk
 * 2026-09-09.
 *
 * 36h on a DAILY job is deliberate slack, not laziness: `neon-sync`'s cron
 * has been observed firing 0.3-11.9h after its nominal time (GitHub delays
 * scheduled runs under load, worse when the repo is quiet). A tighter
 * budget would flap on scheduler jitter alone. Do not "tighten" this into a
 * flaky alarm — the slack is load-bearing.
 *
 * release-please is weekly (Mondays), so its budget is days, not hours:
 * 8 days catches a truly-dead schedule while giving a full week of jitter
 * room before alarming.
 */
export const MONITORED_WORKFLOWS: WorkflowConfig[] = [
  {
    file: "neon-sync.yml",
    name: "neon-sync",
    cronDescription: "0 8 * * * (daily 08:00 UTC)",
    staleAfterHours: 36,
  },
  {
    file: "drift-alert.yml",
    name: "drift-alert",
    cronDescription: "0 22 * * * (daily 22:00 UTC)",
    staleAfterHours: 36,
  },
  {
    file: "discovery-watchdog.yml",
    name: "discovery-watchdog",
    cronDescription: "0 23 * * * (daily 23:00 UTC)",
    staleAfterHours: 36,
  },
  {
    file: "googlebot-canary.yml",
    name: "googlebot-canary",
    cronDescription: "0 6 * * * (daily 06:00 UTC)",
    staleAfterHours: 36,
  },
  {
    file: "release-please.yml",
    name: "release-please",
    cronDescription: "0 9 * * 1 (Mondays 09:00 UTC)",
    staleAfterHours: 8 * 24,
  },
];

/** The subset of the GitHub Actions "list workflow runs" API response this module reads. */
export interface WorkflowRun {
  status: string; // "completed" | "in_progress" | "queued" | ...
  conclusion: string | null; // "success" | "failure" | "timed_out" | "cancelled" | null
  created_at: string; // ISO 8601
}

export interface WorkflowClassification {
  file: string;
  name: string;
  state: WorkflowState;
  /** Count of consecutive most-recent COMPLETED runs that failed. 0 unless state === "failing". */
  streak: number;
  /** ISO timestamp of the newest run, or null if never-run. */
  lastRunAt: string | null;
  detail: string;
}

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"]);

/**
 * Pure classifier — no network, no Date.now(). `now` is always injected so
 * tests control time exactly; this is the seam automation-health.test.ts
 * exercises directly.
 *
 * `runs` is the API's run list, newest-first (as GitHub returns it).
 */
export function classifyWorkflow(
  cfg: WorkflowConfig,
  runs: WorkflowRun[],
  now: Date
): WorkflowClassification {
  const base = { file: cfg.file, name: cfg.name };

  if (runs.length === 0) {
    return {
      ...base,
      state: "never-run",
      streak: 0,
      lastRunAt: null,
      detail: `No scheduled runs found for ${cfg.name} (expected ${cfg.cronDescription}).`,
    };
  }

  const newest = runs[0];
  const lastRunAt = newest.created_at;
  const ageMs = now.getTime() - new Date(lastRunAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageHours > cfg.staleAfterHours) {
    return {
      ...base,
      state: "stale",
      streak: 0,
      lastRunAt,
      detail:
        `Newest run is ${ageHours.toFixed(1)}h old, budget is ${cfg.staleAfterHours}h ` +
        `(expected ${cfg.cronDescription}). Reported even though the run itself may have ` +
        `succeeded — a stale success is still a dead schedule.`,
    };
  }

  // An in_progress/queued newest run is not evidence of failure — judge on
  // the newest run that has actually completed.
  const completedRuns = runs.filter((r) => r.status === "completed");
  if (completedRuns.length === 0) {
    return {
      ...base,
      state: "ok",
      streak: 0,
      lastRunAt,
      detail: `Newest run is still ${newest.status}; no completed run to judge yet, within budget.`,
    };
  }

  const newestCompleted = completedRuns[0];
  if (newestCompleted.conclusion && FAILURE_CONCLUSIONS.has(newestCompleted.conclusion)) {
    let streak = 0;
    for (const r of completedRuns) {
      if (r.conclusion && FAILURE_CONCLUSIONS.has(r.conclusion)) {
        streak += 1;
      } else {
        break; // only the LEADING run of consecutive failures counts
      }
    }
    return {
      ...base,
      state: "failing",
      streak,
      lastRunAt,
      detail: `${streak} consecutive failed run(s), most recent concluded "${newestCompleted.conclusion}".`,
    };
  }

  return {
    ...base,
    state: "ok",
    streak: 0,
    lastRunAt,
    detail: `Newest completed run succeeded, ${ageHours.toFixed(1)}h ago (budget ${cfg.staleAfterHours}h).`,
  };
}

interface GhRunsResponse {
  workflow_runs: WorkflowRun[];
}

async function fetchRuns(owner: string, repo: string, file: string, token: string): Promise<WorkflowRun[]> {
  const url =
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${file}/runs` +
    `?event=schedule&per_page=10`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    // Never echo the token; the response body is public API text, safe to log.
    throw new Error(`GitHub API ${res.status} fetching runs for ${file}: ${await res.text()}`);
  }
  const body = (await res.json()) as GhRunsResponse;
  return body.workflow_runs;
}

function runsUrl(owner: string, repo: string, file: string): string {
  return `https://github.com/${owner}/${repo}/actions/workflows/${file}`;
}

function printSummaryTable(results: WorkflowClassification[]): void {
  console.log("Automation health check:");
  for (const r of results) {
    const marker = r.state === "ok" ? "OK" : r.state.toUpperCase();
    console.log(`  [${marker}] ${r.name} (${r.file}) — ${r.detail}`);
  }
}

/**
 * Repeated verbatim in every report this script can emit — including the
 * "could not check" one — so no generated issue ever overstates the guarantee.
 */
const SELF_STALENESS_NOTE =
  "_This check cannot detect its own staleness. If `automation-health.yml` itself stops " +
  "running, nothing here will say so — one level of recursion is where this stops, and " +
  "pretending otherwise would be the same false-confidence bug this check exists to fix._";

function buildMarkdownReport(
  results: WorkflowClassification[],
  owner: string,
  repo: string
): string {
  const unhealthy = results.filter((r) => r.state !== "ok");
  const lines: string[] = [];

  lines.push("# Automation health report");
  lines.push("");
  if (unhealthy.length === 0) {
    lines.push("All monitored scheduled workflows are healthy.");
  } else {
    lines.push(`${unhealthy.length} of ${results.length} monitored workflow(s) need attention:`);
    lines.push("");
    for (const r of unhealthy) {
      lines.push(`## ${r.name} — ${r.state}`);
      lines.push("");
      lines.push(`- **File:** \`${r.file}\``);
      lines.push(`- **State:** ${r.state}`);
      lines.push(`- **Failure streak:** ${r.streak}`);
      lines.push(`- **Last run:** ${r.lastRunAt ?? "never"}`);
      lines.push(`- **Detail:** ${r.detail}`);
      lines.push(`- **Runs page:** ${runsUrl(owner, repo, r.file)}`);
      lines.push("");
    }
  }
  lines.push("---");
  lines.push(SELF_STALENESS_NOTE);
  return lines.join("\n");
}

/**
 * The report for the paths where the check could not run AT ALL — no token, no
 * repo slug. Deliberately shaped like the normal report so it travels the same
 * route to the same reader, and so it reads as a PROBLEM rather than as an
 * absence. "Could not check" is the one verdict most easily mistaken for
 * "nothing to report".
 */
export function buildCannotCheckReport(reason: string): string {
  return [
    "# Automation health report",
    "",
    "**The health check could not run at all.** This is not a clean bill of health:",
    "nothing was verified, so any monitored workflow may be dead and unreported.",
    "",
    `- **Reason:** ${reason}`,
    "",
    "---",
    SELF_STALENESS_NOTE,
  ].join("\n");
}

/**
 * The ONLY place either outcome signal is written — and it always writes both.
 *
 * Both "cannot check" paths in `main()` used to call `process.exit(1)`
 * directly. That set the exit code but left `healthy` unwritten in
 * $GITHUB_OUTPUT, and the workflow gates issue-filing on
 * `steps.health.outputs.healthy == 'false'` — so an unset value SKIPPED it.
 * The run went red and no issue was opened. Red runs having no reader is the
 * entire reason this script exists, which made the one branch meant to shout
 * "I could not check" the one branch that stayed silent.
 *
 * Putting the report file and the step output behind a single call is what
 * stops them drifting apart again: there is no longer a way to emit one
 * without the other.
 */
export function emitOutcome(opts: {
  healthy: boolean;
  markdown: string;
  out: string | null;
  /**
   * Only GITHUB_OUTPUT is ever read. Typed as exactly that rather than as
   * NodeJS.ProcessEnv, which this project augments with a required NODE_ENV
   * and so cannot be satisfied by a test fixture without an `as` cast.
   */
  env?: { GITHUB_OUTPUT?: string };
}): void {
  const env = opts.env ?? process.env;
  if (opts.out) {
    writeFileSync(opts.out, opts.markdown, "utf8");
  }
  if (env.GITHUB_OUTPUT) {
    writeFileSync(env.GITHUB_OUTPUT, `healthy=${opts.healthy}\n`, { flag: "a" });
  }
}

function parseArgs(argv: string[]): { out: string | null } {
  let out: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    }
  }
  return { out };
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));

  // Fails closed AND audibly: emits the same two signals as an unhealthy
  // verdict before exiting, so "could not check" reaches the issue rather than
  // dying as a red X.
  function cannotCheck(reason: string): never {
    console.error(
      `${reason} Failing closed: 'could not check' must never be reported as 'healthy'.`
    );
    emitOutcome({ healthy: false, markdown: buildCannotCheckReport(reason), out });
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    cannotCheck("GITHUB_TOKEN is not set — cannot query the Actions API.");
  }

  const repoSlug = process.env.GITHUB_REPOSITORY;
  if (!repoSlug || !repoSlug.includes("/")) {
    cannotCheck(
      `GITHUB_REPOSITORY is not set (or malformed: "${repoSlug ?? ""}") — cannot query the Actions API.`
    );
  }
  const [owner, repo] = repoSlug.split("/");

  const now = new Date();
  const results: WorkflowClassification[] = [];

  for (const cfg of MONITORED_WORKFLOWS) {
    try {
      const runs = await fetchRuns(owner, repo, cfg.file, token);
      results.push(classifyWorkflow(cfg, runs, now));
    } catch (err) {
      // A fetch error is itself an unhealthy signal — fail closed per-workflow
      // rather than skip it silently.
      results.push({
        file: cfg.file,
        name: cfg.name,
        state: "never-run",
        streak: 0,
        lastRunAt: null,
        detail: `Could not fetch runs: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  printSummaryTable(results);

  const healthy = results.every((r) => r.state === "ok");
  emitOutcome({ healthy, markdown: buildMarkdownReport(results, owner, repo), out });
  if (out) {
    console.log(`Wrote markdown report to ${out}`);
  }

  process.exit(healthy ? 0 : 1);
}

// Only run the CLI when this file is executed directly, not when its exports
// are imported by the test suite — matches scripts/check-schema-drift.ts's
// isMain guard (same underlying pattern as scripts/sync-to-neon.ts).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
