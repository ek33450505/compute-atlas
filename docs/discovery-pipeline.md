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
  research prompt template. Contains four responsibilities: (1) discover
  net-new facilities, (2) re-check existing facilities for genuine status changes,
  (3) enrich missing facts on existing facilities, and (4) re-source dead links.
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
in a single daily `claude -p` call, driven by a four-responsibility prompt.

- **Single call, four responsibilities:** `discovery-prompt.txt` directives:
  (1) research net-new AI/crypto/power facilities in the state, (2) re-check
  existing facilities in that state for genuine status changes since their
  `statusHistory` was last updated, (3) enrich missing facts on existing
  facilities, and (4) re-source dead links. Results are combined into one output
  array and submitted in a single batch.
- **{{EXISTING_FACILITIES}} injection:** `existing-facilities.ts` projects
  a compact line-per-facility view, one per line:
  `id | name | operator | status | <latest statusHistory date> | <primary source url> | missing:<comma-separated enrichable families, or "none">`.
  The `missing:` field lists enrichable fields (capacity, energy, water, jobs, community, etc.) that Compute Atlas does not yet have for that facility, driving Responsibility 3 (enrichment). Kept compact (~100 chars/line) so a large state stays
  well under 5KB in the prompt. `run.sh` fetches this projection fail-open
  (logs a warning to the run log and `existing-facilities.err` on failure;
  proceeds with an empty string if unavailable), and injects it via a
  sed `r` (read-file) command that never shell-evaluates the projection's
  content — critical because facility names, operators, and URLs may contain
  slashes, ampersands, newlines, and shell metacharacters.

## Update and enrichment semantics: append-only intent model

Discovery (Responsibilities 2, 3, and 4) never reconstructs full facility documents.
Instead, it emits compact, append-only intents that the server applies safely:

### Status updates (Responsibility 2)

When a genuine status change is found (e.g., "proposed" → "under_construction"),
emit a `statusUpdate` intent:
```json
{ "statusUpdate": { "targetFacilityId": "<exact id from projection>",
  "status": "<new status>", "date": "<today, YYYY-MM-DD>",
  "note": "<brief sourced explanation>",
  "sources": [ { "url": "...", "label": "...", "retrievedAt": "...", "kind": "..." } ]
}, "provenance": { "sources": ["<url>"], "confidence": "confirmed", ... } }
```
The server appends the new source(s) to the facility's sources array, adds a
statusHistory entry (with sourceIndex pointing to the first appended source),
and preserves all existing fields. The facility never loses prior sources,
history entries, or sourceIndex references.

**Fail-safe:** If no genuine, citable status change is found, emit nothing for that facility.

### Enrichment updates (Responsibility 3)

For missing facts listed in the `missing:` token, emit an `enrichmentUpdate` intent.
The enrichable families go inside a strict `fields` object (the server rejects unknown
keys), and `sources` / `date` sit alongside it:
```json
{ "enrichmentUpdate": { "targetFacilityId": "<id>",
  "date": "<today, YYYY-MM-DD>",
  "sources": [ { "url": "...", "label": "...", "retrievedAt": "...", "kind": "..." } ],
  "fields": { "capacityMw": { "operational": 100 }, "energy": { "source": "solar" } }
}, "provenance": { ... } }
```
Fill ONLY families listed in that facility's `missing:` token (`capacityMw`, `energy`,
`water`, `location`, `investmentUsd`, `landAcres`, `aiClassification`, `jobs`,
`community`, `subsidies`). Enrichment is fill-missing, not overwrite: the server sets a
family only when the curated record doesn't already have it, and appends the new
sources — it never reorders or drops existing sources. Families that carry their own
citation (`jobs`, `community`, `subsidies`) include a `sourceRel` index into this
intent's own `sources[]`.

### Source refresh (Responsibility 4)

When a facility's projection carries a trailing `=== DEAD SOURCES (re-source these) ===`
block (`facilityId | deadUrl` lines, fed from the prior check-sources report), find a
currently-live replacement citation for the same fact and fold it into that facility's
`enrichmentUpdate`: include the replacement in `sources`, and add a `reSourced` entry —
`{ "replacesUrl": "<exact dead url>", "sourceRel": <index of the replacement within this
intent's sources[]> }`. The dead source is never removed — the server only appends the
fresh citation (a human prunes later). Responsibility 3 fills and Responsibility 4
re-sourcing for the same facility may be combined into one `enrichmentUpdate` element.

**Key principle:** Every intent is validated against the facility schema server-side.
Never restate fields you cannot see from the projection or prior submissions.
Omit a field if you have no new citable source for it.

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
  (new + updated combined) submitted per run. The cap **self-reverts**: 10/day
  for the first 20 days from the burst-start date baked into `run.sh`, then
  automatically 5/day — no manual step to revert. `MAX_CANDIDATES` in the
  environment overrides the computed cap (escape hatch / tests).
- **No silent drops:** every skipped candidate (invalid schema, missing
  sources, duplicate, over cap, no genuine status change) is logged with a
  reason, both to stdout and to a JSON run summary in `discovery-logs/run-<runId>.json`.
- **Survives a session-limit / unparseable reply:** if the `claude -p` call
  exits nonzero (e.g. "You've hit your session limit") or returns no parseable
  JSON array, the run no longer crashes under `set -e` — it logs a WARN, skips
  the submit step (nothing to stage), still runs the source-liveness check, and
  records the outcome in the heartbeat below.
- **Heartbeat:** every real (non-dry-run) invocation writes
  `discovery-logs/heartbeat.json` (`lastRunAt`, `runId`, `state`, `claudeStatus`)
  as it completes. A stale `lastRunAt` means the daily job isn't running (a
  launchd sleep-skip or crash); `claudeStatus: no_array` means the run reached
  `claude` but got a session-limit/prose reply rather than candidates. A manual
  dry-run deliberately does not write the heartbeat, so it never masks a real
  launchd failure.
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
key instead of the subscription). Once a run *has* started, `run.sh` wraps the
`claude -p` call in `caffeinate -i` (macOS only; a no-op elsewhere) so idle sleep
can't suspend a long research call mid-run.

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

When approving an update submission with a `statusUpdate` or `enrichmentUpdate` intent,
the server applies the append-only transformation: new sources are appended to the
facility's sources array, new enrichment fields are merged in (filling only keys
present in the intent), and statusHistory entries are appended if present. All
existing data is preserved — nothing is replaced or reordered.

Nothing becomes a live facility without one of these explicit human calls.

## Source-health reporting

The `check-sources.ts` utility runs after every discovery invocation and probes
the liveness of every source URL across all facilities. It generates a JSON
report at `discovery-logs/source-health-<timestamp>.json` with per-URL status
classifications: `ok` (2xx), `redirected` (3xx), `gone` (404/410/451), `bot_blocked`
(401/403 anti-bot), `throttled` (429 rate-limited), `server_error` (5xx),
`client_error` (other 4xx), `timeout`, `error`, `blocked` (SSRF-guard refusal).
Note that `bot_blocked` and `throttled` are transient/anti-bot signals, not
"dead" sources. This is a flag/report-only tool — it never modifies facilities or
submissions. A future enhancement may wire these reports into an admin dashboard
or automated deprecation workflow.
