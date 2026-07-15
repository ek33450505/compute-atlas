# Discovery pipeline (Phase 5)

A local, scheduled, subscription-powered pipeline that proposes candidate
facilities into the Phase 4 staging queue AND re-checks existing facilities
for genuine status changes. It NEVER writes live facilities — every candidate
(new or updated) lands as a `pending` row in `submissions`, reviewed and
approved/rejected by a human via the Phase 4 CLI.

## Architecture

```
run.sh (launchd, daily)
  1. kill switch check (fail-closed)
  2. pick next state from a rotation cursor
  3. fetch existing-facilities projection for state
  4. claude -p <discovery-prompt.txt with {{STATE}} + {{EXISTING_FACILITIES}}>  → JSON array
  5. submit-candidates.ts <candidates.json>            → POST /api/submissions
  6. check-sources.ts                                   → source-health-<timestamp>.json (read-only)
```

- `scripts/discovery/submit-candidates.ts` — deterministic core. Validates
  each candidate against `facilitySchema`, dedupes against the live facility
  set (by `id` and by case-insensitive `name`+`state`+`city`), classifies as
  `create`/`update`, caps how many it submits per run, and POSTs to
  `/api/submissions` with `Authorization: Bearer $API_ADMIN_TOKEN`.
- `scripts/discovery/run.sh` — the scheduled harness. Owns the kill switch,
  the state-rotation cursor, the existing-facilities fetch, the single
  `claude -p` research call, and coordination with source-liveness checks.
  The research call is pinned to JSON-only output with a system-level batch
  contract (`--append-system-prompt`), so the headless session can't fall back
  to a prose session-summary that the submit step would then fail to parse. It
  also runs under a `timeout`/`gtimeout` wall-clock cap when one is available
  (macOS ships neither by default — in that case it runs uncapped and logs a
  WARN).
- `scripts/discovery/discovery-prompt.txt` — the bounded, single-session
  research prompt template. Contains two responsibilities: (1) discover
  net-new facilities, (2) re-check existing facilities for status changes.
  Uses `{{STATE}}` and `{{EXISTING_FACILITIES}}` placeholders substituted
  by `run.sh`.
- `scripts/discovery/existing-facilities.ts` — projects a compact line-per-facility
  view of all existing facilities in a state for the discovery prompt, enabling
  status-refresh passes without full facility documents.
- `scripts/discovery/check-sources.ts` — mechanical (no LLM) source-liveness
  checker. Probes every facility source URL with bounded-concurrency HEAD-then-GET.
  Runs every invocation (read-only, even in dry-run). Reports classifications
  to `discovery-logs/source-health-<timestamp>.json` (flag/report only,
  never auto-edits).
- `scripts/discovery/com.compute-atlas.discovery.plist` — launchd template.

## The combined-pass model

Since Phase 5 launch (s30, 2026-07-14), each scheduled invocation now does
**both** discovery of net-new facilities AND re-checking of existing facilities
in a single daily `claude -p` call, driven by a two-responsibility prompt.

- **Single call, dual responsibility:** `discovery-prompt.txt` directives:
  (1) research net-new AI/crypto/power facilities in the state, (2) re-check
  existing facilities in that state for genuine status changes since their
  `statusHistory` was last updated. Both results are combined into one output
  array and submitted in a single batch.
- **{{EXISTING_FACILITIES}} injection:** `existing-facilities.ts` projects
  a compact line-per-facility view, one per line:
  `id | name | operator | status | <latest statusHistory date> | <primary source url>`.
  Kept compact (~100 chars/line) so a large state (TX, ~43 facilities) stays
  well under 5KB in the prompt. `run.sh` fetches this projection fail-open
  (logs a warning to the run log and `existing-facilities.err` on failure;
  proceeds with an empty string if unavailable), and injects it via a
  sed `r` (read-file) command that never shell-evaluates the projection's
  content — critical because facility names, operators, and URLs may contain
  slashes, ampersands, newlines, and shell metacharacters.

## Full-document update semantics

When the discovery prompt finds a genuine status change (e.g., "proposed" →
"under_construction" → "operational") and emits an update for an existing
facility:

- **Complete vs. partial:** The update MUST be a complete, valid facility
  document (same schema, same `id`), NOT a partial patch. The staging queue
  classification logic (`submit-candidates.ts:150-155`) matches by `id` to
  determine whether a submission is a `create` or `update`. An update then
  routes to `approveSubmission` → `updateFacility`, which replaces the
  entire facility record.
- **statusHistory semantics:** APPEND a new entry to the existing
  `statusHistory` array (new status + today's date), never replace or reorder.
  The entry includes the index of the new source that corroborates the change.
  Existing history must remain intact — `statusHistory` is the immutable audit
  trail.
- **Field rules:**
  - `status`: updated to the new, source-backed status.
  - `lastUpdated`: bumped to today's date.
  - `sources`: APPEND the new corroborating source to the existing sources
    array. If you cannot reconstruct the full prior sources array, include
    at minimum the projection's primary source URL plus your new source, so
    the array stays non-empty and traceable.
  - **All other fields** (name, operator, location, capacity, type, confidence):
    carried through unchanged. This is a status-only refresh, not a full-fact
    refresh — do not attempt to verify/update anything except status/history/
    sources/lastUpdated.
- **Fail-safe:** If the prompt cannot find a genuine, citable status change
  for a facility listed in the projection, do not emit an entry for it at all.
  Do not "refresh" or touch a facility merely because it appeared in the list
  — omit it entirely from the output.

## Safety properties

- **Staging-only:** the pipeline only ever calls `POST /api/submissions`. It
  never calls `/api/facilities` and never edits `data/facilities.json`.
  Promotion to a live facility (new or updated) happens only via `npm run submissions --
  approve <id>` (Phase 4), a deliberate human action.
- **Fail-closed kill switch:** `run.sh` exits 0 immediately unless
  `DISCOVERY_ENABLED=true` is set in the environment, or if
  `discovery-logs/DISABLED` exists. The launchd plist deliberately does NOT
  set `DISCOVERY_ENABLED` — enabling it is a separate, deliberate step.
- **Bounded per run:** one state per run (rotation cursor), `--max` candidates
  (new + updated combined) submitted per run (default 5, override via `MAX_CANDIDATES`).
- **No silent drops:** every skipped candidate (invalid schema, missing
  sources, duplicate, over cap, no genuine status change) is logged with a
  reason, both to stdout and to a JSON run summary in `discovery-logs/run-<runId>.json`.
- **Source-liveness check:** read-only, never auto-edits. Runs unconditionally
  every daily invocation (even in dry-run) and reports classifications to
  `discovery-logs/source-health-<timestamp>.json`. Current implementation is
  FLAG-ONLY: no admin UI or automated actions yet (fast-follow planned).

## Cost model and cadence

The discovery step (`claude -p`) uses your Claude subscription (Claude Code
CLI), not the metered Anthropic API — a normal interactive session's quota.
Each run does exactly one bounded, single-session research call for one
state, capped to `--max` submissions (new + updated combined, default 5).
There is no fan-out, no multi-agent workflow, and no `/data-wave` invocation
from this pipeline.

**Cadence unchanged:** The combined-pass model runs on the same daily schedule
as before — one state per 24-hour cycle, one state per launchd invocation, cursor
rotation through 15 states for a roughly two-week full cycle. No new launchd
units, no increase in claude cost.

## Running manually

```bash
# Dry run — no claude call, no POSTs, just exercises the harness end to end.
# Skips existing-facilities fetch but still runs check-sources (read-only).
DISCOVERY_ENABLED=true DISCOVERY_DRY_RUN=true bash scripts/discovery/run.sh

# Real run — fetches existing-facilities projection, spends subscription usage
# on one `claude -p` call (with both responsibilities), then submits candidates
# and runs source-liveness checks.
DISCOVERY_ENABLED=true bash scripts/discovery/run.sh

# Fetch existing-facilities projection for a state (CLI debug).
npx tsx --env-file=.env.local scripts/discovery/existing-facilities.ts --state=TX

# Check source liveness (read-only, generates report).
npx tsx --env-file=.env.local scripts/discovery/check-sources.ts

# Submit an already-prepared candidates file directly (no claude call at all).
npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts \
  path/to/candidates.json --run-id=manual-test --dry-run

# Run tests (unit + integration).
npx vitest run scripts/discovery/*.test.ts
bats tests/discovery/run.bats
```

## Installing the launchd job

```bash
# Fill the template's __REPO_PATH__ placeholders and install a copy.
sed "s|__REPO_PATH__|$(pwd)|g" \
  scripts/discovery/com.compute-atlas.discovery.plist \
  > ~/Library/LaunchAgents/com.compute-atlas.discovery.plist

# Enable it: uncomment DISCOVERY_ENABLED + API_BASE_URL in the installed copy's
# EnvironmentVariables dict (the committed template ships them commented so the
# job is fail-closed by default).

# Load into the GUI domain (so `claude -p` can reach your subscription auth).
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.compute-atlas.discovery.plist
launchctl print gui/$(id -u)/com.compute-atlas.discovery   # verify: state, runs, path
```

The job runs daily at 13:00 local, one state per run (the cursor rotates
through 15 states — roughly a full cycle every two weeks). It stays a no-op
until you uncomment `DISCOVERY_ENABLED=true` (fail-closed by default — see the
kill switch above).

Midday (rather than overnight) is deliberate: macOS `launchd` defers a missed
`StartCalendarInterval` to the next wake, so an early-morning slot is simply
skipped whenever the Mac is asleep. 13:00 assumes the machine is normally awake
and lid-open then — if your usage differs, pick an hour when the Mac is reliably
on, or move the job off the laptop entirely (e.g. a cron/CI runner with an API
key instead of the subscription).

**PATH gotcha:** launchd runs with a bare `PATH`, so the plist's
`EnvironmentVariables` must list wherever `claude`/`node`/`npx` live
(`/opt/homebrew/bin` on a Homebrew install). Without it the job cannot find
them and fails in `discovery-logs/launchd.err`.

**Auth note:** `claude -p` needs an authenticated Claude Code subscription
session. Verified (2026-07-15): it authenticates fine from the background
launchd context — a scheduled run reaches your subscription without an
interactive shell. If it ever regresses, `discovery-logs/launchd.err` is where
it surfaces; the fallbacks are a login-session launcher or the manual
invocation above.

To reload after editing the plist:
`launchctl bootout gui/$(id -u)/com.compute-atlas.discovery && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.compute-atlas.discovery.plist`

To disable without unloading: `touch discovery-logs/DISABLED`.
To remove entirely: `launchctl bootout gui/$(id -u)/com.compute-atlas.discovery`.

## Reviewing candidates and updates

Every candidate the pipeline submits (new or updated) lands as a `pending` row
in the submissions staging queue. Review with the Phase 4 CLI:

```bash
npm run submissions -- list pending
npm run submissions -- approve <id> "looks good, verified sources"
npm run submissions -- reject <id> "source doesn't support the claim"
```

When approving an update submission, the operation replaces the entire facility
record with the updated document (matching the same `id`), so the existing
`statusHistory` is preserved and appended with the new status entry.

Nothing becomes a live facility without one of these explicit human calls.

## Source-health reporting

The `check-sources.ts` utility runs after every discovery invocation and probes
the liveness of every source URL across all facilities. It generates a JSON
report at `discovery-logs/source-health-<timestamp>.json` with per-URL status
classifications: `ok` (2xx), `redirected` (3xx), `dead` (4xx/5xx), `timeout`,
`error`. This is a flag/report-only tool — it never modifies facilities or
submissions. A future Phase 5.1 enhancement may wire these reports into an
admin dashboard or automated deprecation workflow.
