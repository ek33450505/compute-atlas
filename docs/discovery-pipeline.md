# Discovery pipeline (Phase 5)

A local, scheduled, subscription-powered pipeline that proposes candidate
facilities into the Phase 4 staging queue. It NEVER writes live facilities —
every candidate lands as a `pending` row in `submissions`, reviewed and
approved/rejected by a human via the Phase 4 CLI.

## Architecture

```
run.sh (launchd, daily)
  1. kill switch check (fail-closed)
  2. pick next state from a rotation cursor
  3. claude -p <discovery-prompt.txt with {{STATE}}>  → JSON array on stdout
  4. submit-candidates.ts <candidates.json>            → POST /api/submissions
```

- `scripts/discovery/submit-candidates.ts` — deterministic core. Validates
  each candidate against `facilitySchema`, dedupes against the live facility
  set (by `id` and by case-insensitive `name`+`state`+`city`), classifies as
  `create`/`update`, caps how many it submits per run, and POSTs to
  `/api/submissions` with `Authorization: Bearer $API_ADMIN_TOKEN`.
- `scripts/discovery/run.sh` — the scheduled harness. Owns the kill switch,
  the state-rotation cursor, and the single `claude -p` research call.
- `scripts/discovery/discovery-prompt.txt` — the bounded, single-session
  research prompt template (`{{STATE}}` substituted by `run.sh`).
- `scripts/discovery/com.compute-atlas.discovery.plist` — launchd template.

## Safety properties

- **Staging-only:** the pipeline only ever calls `POST /api/submissions`. It
  never calls `/api/facilities` and never edits `data/facilities.json`.
  Promotion to a live facility happens only via `npm run submissions --
  approve <id>` (Phase 4), a deliberate human action.
- **Fail-closed kill switch:** `run.sh` exits 0 immediately unless
  `DISCOVERY_ENABLED=true` is set in the environment, or if
  `discovery-logs/DISABLED` exists. The launchd plist deliberately does NOT
  set `DISCOVERY_ENABLED` — enabling it is a separate, deliberate step.
- **Bounded per run:** one state per run (rotation cursor), `--max` candidates
  submitted per run (default 5, override via `MAX_CANDIDATES`).
- **No silent drops:** every skipped candidate (invalid schema, missing
  sources, duplicate, over cap) is logged with a reason, both to stdout and
  to a JSON run summary in `discovery-logs/run-<runId>.json`.

## Cost model

The discovery step (`claude -p`) uses your Claude subscription (Claude Code
CLI), not the metered Anthropic API — a normal interactive session's quota.
Each run does exactly one bounded, single-session research call for one
state, capped to `--max` submissions. There is no fan-out, no multi-agent
workflow, and no `/data-wave` invocation from this pipeline.

## Running manually

```bash
# Dry run — no claude call, no POSTs, just exercises the harness end to end.
DISCOVERY_ENABLED=true DISCOVERY_DRY_RUN=true bash scripts/discovery/run.sh

# Real run — spends subscription usage on one `claude -p` call, then submits
# whatever it finds to the staging queue.
DISCOVERY_ENABLED=true bash scripts/discovery/run.sh

# Submit an already-prepared candidates file directly (no claude call at all).
npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts \
  path/to/candidates.json --run-id=manual-test --dry-run
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

The job runs daily at 03:00 local, one state per run (the cursor rotates
through 15 states — roughly a full cycle every two weeks). It stays a no-op
until you uncomment `DISCOVERY_ENABLED=true` (fail-closed by default — see the
kill switch above).

**PATH gotcha:** launchd runs with a bare `PATH`, so the plist's
`EnvironmentVariables` must list wherever `claude`/`node`/`npx` live
(`/opt/homebrew/bin` on a Homebrew install). Without it the job cannot find
them and fails in `discovery-logs/launchd.err`.

**Auth caveat:** `claude -p` needs an authenticated Claude Code subscription
session. It works in an interactive shell; whether it authenticates from the
background launchd context is worth confirming on the first scheduled run —
check `discovery-logs/launchd.err` after it fires.

To reload after editing the plist:
`launchctl bootout gui/$(id -u)/com.compute-atlas.discovery && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.compute-atlas.discovery.plist`

To disable without unloading: `touch discovery-logs/DISABLED`.
To remove entirely: `launchctl bootout gui/$(id -u)/com.compute-atlas.discovery`.

## Reviewing candidates

Every candidate the pipeline submits lands as a `pending` row. Review with
the Phase 4 CLI:

```bash
npm run submissions -- list pending
npm run submissions -- approve <id> "looks good, verified sources"
npm run submissions -- reject <id> "source doesn't support the claim"
```

Nothing becomes a live facility without one of these explicit human calls.
