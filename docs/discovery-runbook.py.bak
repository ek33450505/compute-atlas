# Discovery runbook

Day-to-day operations for the discovery pipeline. For architecture and the safety contract, see [discovery-pipeline.md](./discovery-pipeline.md).

## Setting up Ollama

The source verification gate requires a local Ollama daemon with the verification model pulled.

### Setup

```bash
ollama pull gpt-oss:20b
ollama ps                                  # a loaded model shows GPU in the PROCESSOR column
curl -s http://127.0.0.1:11434/api/tags    # confirm the daemon is reachable
```

### Configuration

Configuration is optional; defaults come from `ollama-client.ts`:

| Variable | Default | Notes |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | |
| `OLLAMA_VERIFY_MODEL` | `gpt-oss:20b` | must be pulled locally |
| `OLLAMA_TIMEOUT_MS` | `120000` | per-call abort timeout; used when it parses as a positive finite number, otherwise the default |
| `VERIFY_SOURCES_ENABLED` | gate is on | `false` is the only opt-out |

If the daemon is down or the model is not pulled, the gate returns `unavailable` and the run aborts rather than submitting unverified candidates. This is deliberate: `unavailable` means "we could not check", never "the source is bad". The only opt-out is an explicit `VERIFY_SOURCES_ENABLED=false`.

## Installing the launchd job

Fill the template's `__REPO_PATH__` placeholders and install a copy:

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

The job runs daily at 13:00 local, processing `STATES_PER_RUN` states per invocation (default 2) from a rotation cursor. It stays a no-op until you uncomment `DISCOVERY_ENABLED=true` (fail-closed by default).

Midday (rather than overnight) is deliberate: macOS `launchd` defers a missed `StartCalendarInterval` to the next wake, so an early-morning slot is simply skipped whenever the Mac is asleep. 13:00 assumes the machine is normally awake and lid-open then — if your usage differs, pick an hour when the Mac is reliably on, or move the job off the laptop entirely (e.g. a cron/CI runner with an API key instead of the subscription). Once a run *has* started, `run.sh` wraps the `claude -p` call in `caffeinate -i` (macOS only; a no-op elsewhere) so idle sleep can't suspend a long research call mid-run.

### PATH gotcha

launchd runs with a bare `PATH`, so the plist's `EnvironmentVariables` must list wherever `claude`/`node`/`npx` live (`/opt/homebrew/bin` on a Homebrew install). Without it the job cannot find them and fails in `discovery-logs/launchd.err`.

### Auth note

`claude -p` needs an authenticated Claude Code subscription session. Verified (2026-07-15): it authenticates fine from the background launchd context — a scheduled run reaches your subscription without an interactive shell. If it ever regresses, `discovery-logs/launchd.err` is where it surfaces; the fallbacks are a login-session launcher or the manual invocation below.

### Ollama note

The scheduled run submits candidates, so it needs the Ollama daemon reachable at `OLLAMA_BASE_URL` with `OLLAMA_VERIFY_MODEL` pulled at the time the job fires — a machine that is awake but has no Ollama running will abort the run at the verification gate rather than stage anything.

## Managing the launchd job

To reload after editing the plist:

```bash
launchctl bootout gui/$(id -u)/com.compute-atlas.discovery && \
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.compute-atlas.discovery.plist
```

To disable without unloading:

```bash
touch discovery-logs/DISABLED
```

To remove entirely:

```bash
launchctl bootout gui/$(id -u)/com.compute-atlas.discovery
```

## Running manually

### Trigger the real scheduled job (preferred)

Run the actual launchd job instead of the raw script. This runs the pipeline in launchd's environment (its own PATH, env vars, and stdout/stderr redirection), matching the scheduled invocation exactly.

```bash
npm run discovery:now
```

This is preferred over `bash scripts/discovery/run.sh` because it exercises the production scheduler, not an ad-hoc interactive shell. The difference matters: launchd once fired correctly while headless `claude -p` failed inside it, and the pipeline staged zero candidates for six days — recorded in the comment block at the top of `scripts/discovery/run.sh` (the 2026-08-14 note: "heartbeat.json recorded claudeStatus=no_array every day for SIX consecutive days and nothing surfaced it"). A manual run that does not reproduce the scheduled environment can pass while the scheduled one is broken. Use `discovery:now` for a missed or extra round; use the raw `bash scripts/discovery/run.sh` form only when you deliberately need to override env vars (`DISCOVERY_DRY_RUN`, `DISCOVERY_STATES`, `STATES_PER_RUN`, etc.), since `launchctl kickstart` cannot pass those.

To force-restart a run already in flight (killing it first):

```bash
launchctl kickstart -k gui/$(id -u)/com.compute-atlas.discovery
```

**Why this is needed:** macOS `StartCalendarInterval` does NOT catch up a scheduled run missed while the machine was off or asleep — it waits for the next occurrence. Observed 2026-09-05: the Mac booted at 13:32:43, 32 minutes after the 13:00 schedule; `launchctl print` reported `runs = 0` / `last exit code = (never exited)`, and that day's round simply never happened with no error anywhere. Without a manual trigger, no discovery runs that day at all. The watchdog (see [Discovery watchdog](#discovery-watchdog) below) detects this on its own schedule in GitHub Actions; `discovery:now` is the operator's manual recovery tool.

### Dry run

Exercises the harness end to end without making any API calls or writes. Skips existing-facilities fetch but still runs check-sources (read-only).

```bash
DISCOVERY_ENABLED=true DISCOVERY_DRY_RUN=true bash scripts/discovery/run.sh
```

### Real run

Fetches existing-facilities projection, spends subscription usage on one `claude -p` call (with both responsibilities), then submits candidates and runs source-liveness checks.

```bash
DISCOVERY_ENABLED=true bash scripts/discovery/run.sh
```

### Targeted state run

Override the rotation cursor entirely:

```bash
DISCOVERY_ENABLED=true DISCOVERY_STATES="IA NE" STATES_PER_RUN=2 \
  bash scripts/discovery/run.sh
```

### Utilities

Fetch existing-facilities projection for a state (CLI debug):

```bash
npx tsx --env-file=.env.local scripts/discovery/existing-facilities.ts --state=TX
```

Check source liveness (read-only, generates report):

```bash
npx tsx --env-file=.env.local scripts/discovery/check-sources.ts
```

Submit an already-prepared candidates file directly (no claude call at all):

```bash
npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts \
  path/to/candidates.json --run-id=manual-test --dry-run
```

Run tests (unit + integration):

```bash
npx vitest run scripts/discovery/*.test.ts
bats tests/discovery/run.bats
```

## Discovery watchdog

An off-machine monitor in GitHub Actions detects when the local discovery pipeline has not run at all (the failure mode `run.sh` cannot self-detect, since it only fires when it runs).

**Why off-machine?** `run.sh` already alerts on its own failures — desktop notification plus a nonzero exit — but it documents its own blind spot: it cannot detect "launchd never fired at all". A watchdog on the same machine shares that blind spot exactly. macOS `StartCalendarInterval` does NOT catch up a missed run: if the machine is asleep/off at 13:00 local, the run simply never happens, and nothing on that machine errors (there's nothing there to error — the job never fired). A monitor running in GitHub Actions can detect this gap even if the Mac stays asleep indefinitely.

**Mechanism:** `run.sh` writes `discovery-logs/heartbeat.json` after every run (successful or degraded). `run.sh` then publishes it to a `discovery_heartbeat` row in Neon, invoking `scripts/discovery/publish-heartbeat.ts` from inside the same non-dry-run heartbeat block — so `DISCOVERY_DRY_RUN=true` never writes to Neon. A publish failure does not abort the run (the discovery work is already complete by that point and must not be lost), but it is appended to `FAILURES`, so the run still exits nonzero and still fires the desktop notification. To publish a heartbeat by hand, run `npm run discovery:heartbeat`. The `.github/workflows/discovery-watchdog.yml` workflow runs daily at 23:00 UTC (~5–6 hours after the 13:00-local scheduled run) and invokes `npx tsx scripts/discovery/check-heartbeat.ts`, which reads the `discovery_heartbeat` row from Neon and checks its freshness. It calls the script directly rather than the `check:heartbeat` npm script because that script carries `--env-file=.env.local`, which does not exist on a CI runner; there `DATABASE_URL` arrives from the workflow's job env.

**Fails closed:** The script exits nonzero if:
- `DATABASE_URL` is not set
- `DISCOVERY_STALE_HOURS` is set but unparseable as a positive number
- No `discovery_heartbeat` row exists (expected only before the first run after this feature's deploy; any other time means the publisher is broken)
- `last_run_at` is older than the configured threshold (default `DISCOVERY_STALE_HOURS=36`, deliberately matching `run.sh`'s own stale-check threshold so both agree on what "stale" means)

A monitor that silently passes when it cannot check, or when the thing it is meant to detect (silence) has in fact occurred, is worse than no monitor — that is the exact gap this feature exists to close.

**Scope:** Freshness only — "did a discovery run happen recently at all". A run that happened but produced a degraded status still passes the watchdog (with a warning printed); `run.sh` already alerts locally for degraded runs, so the watchdog does not re-judge run quality.

**Manual check:** Verify the watchdog locally (reads `.env.local` for `DATABASE_URL`):

```bash
npm run check:heartbeat
```

**Deploy order matters:** The three pieces are safe only in sequence:
1. `npm run db:migrate` applies the `discovery_heartbeat` table schema (one-time)
2. A discovery run publishes the first heartbeat row (via `publish-heartbeat.ts`, invoked from `run.sh`)
3. Only then is the watchdog meaningful

Between merge and step 2, the workflow WILL fail — first on the missing table, then on the missing row — and that is intentional rather than a bug to work around: discovery genuinely is not being monitored yet during that window. The window typically lasts ~24 hours (until the next 13:00 local run fires).

## Reviewing candidates and updates

Every candidate the pipeline submits (new or updated) lands as a `pending` row in the submissions staging queue. Review with the `submissions` CLI:

```bash
npm run submissions -- list pending
npm run submissions -- approve <id> "looks good, verified sources"
npm run submissions -- reject <id> "source doesn't support the claim"
```

When approving an update submission with a `statusUpdate` or `enrichmentUpdate` intent, the server applies the append-only transformation: new sources are appended to the facility's sources array, new enrichment fields are merged in (filling only keys present in the intent), and statusHistory entries are appended if present. All existing data is preserved — nothing is replaced or reordered.

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

## Field extraction from existing sources

`scripts/discovery/extract-fields.ts` fills missing structured fields on *existing* facilities by re-reading sources those facilities already cite, using a local Ollama model. This is an enrichment tool, not a discovery tool — it never proposes new facilities and it never overwrites a curated value.

### What it does

Fills these structured fields:

- `capacityMw.planned`
- `capacityMw.operational`
- `energy.onSiteGenerationMw`
- `energy.source`
- `energy.utility`
- `water.coolingType`

One field per model call (deliberately not batched). It reads the facility's existing source URLs in order, stopping early the instant all requested fields are filled. Different fields can be sourced from different pages. Dry run (no `--out`) is the DEFAULT: it prints a summary and writes nothing.

Sources are read **primary documents first** (`permit` / `filing` / `iso_queue` /
`subsidy` before `press` / `osm` / `other`), so a press release's paraphrase cannot
beat the filing it paraphrases to a field.

**PDF sources are read** (since PR #199). `.pdf` URLs — and extensionless download
links that turn out to serve `application/pdf` — are extracted with
`pdftotext -layout` and only the extracted TEXT is ever handed to the model or the
quote gate; a PDF's raw bytes are never regexed.

> **Requires poppler:** `brew install poppler`. Without it every PDF source goes
> unread — the run prints one loud `pdf-extractor-unavailable` warning and continues
> DEGRADED rather than aborting, so read for that line before trusting a run's
> coverage. `-layout` is not optional: raw mode splices hyphenated line-breaks
> (`droughttolerant`, `highdemand`) and detaches spec-table labels from their values,
> which yields false "the source does not state this" outcomes.

### Safety properties

- **Staging-only:** never writes live data. The only side effect is a candidates
  file (via `--out`), which is piped through `submit-candidates.ts` to stage
  everything as `pending` for human review. Promotion to live requires an explicit
  human `approve`.
- **Reproducibility:** a locally-tuned Ollama setup (higher `OLLAMA_NUM_PARALLEL`)
  breaks determinism; uses the default (serial) setting, where the model is
  stable.
- **Quote gate:** every extracted value must be backed by a verbatim span of the
  page that also reconciles numerically with the value. Both halves are load-bearing:
  a bare "60" is rejected because, while it is a real span of almost any document,
  it carries no unit and so is evidence for nothing. Mechanical grounding bounds
  fabrication, never semantics. **Known limit:** the gate cannot catch a genuine figure filed
  under the WRONG field (e.g., a page reading "358,000-square-foot, 36-megawatt"
  is real evidence for 36 MW, but the model may return it as `energy.onSiteGenerationMw`
  instead of `capacityMw.operational`). Human review of the `pending` queue is
  what covers that gap — a green gate is not a substitute for it.

### Usage

> ⛔ **Always pass `--fields` explicitly.** Omitting it does NOT mean "the safe
> default" — it means all six fields, including the two the bench measured as NOT
> safe to ship (`capacityMw.planned` P=75%, `energy.onSiteGenerationMw` P=50%; see
> the per-field table below). The pinned list is `capacityMw.operational`,
> `water.coolingType` — both bench-measured: `capacityMw.operational` (P=100%/R=100%)
> and `water.coolingType` (P=95%/R=95%). `energy.source` and `energy.utility` remain
> **extractable but not pinned**: they were unmeasured (the bench could only score
> numeric fields until 2026-09-01, and neither string field carried a label in
> `truth.json`), so they do not run nightly; re-add them only after clearing the
> bench. The `npm run` wrapper below bakes the pinned list in so it cannot be
> forgotten; treat a bare `extract-fields.ts` invocation as an operator error.
>
> ⚠️ `water.coolingType`'s 95% belongs to the PROMPT, not to the field. The same
> model on the same 69 pages scored P=53%/R=42% with a bare vocabulary list and no
> decision rule. `FIELD_DESCRIPTIONS["water.coolingType"]` carries
> `docs/methodology.md#cooling-type`'s definitions and tie-breaker verbatim, and a
> drift test fails if that rule is ever removed. `hybrid` is in the prompt
> vocabulary (removing it would change the benched prompt) but is REFUSED at
> validation, because it has zero positive labels in the corpus. The nightly `run.sh` lane is
> scheduled, but never bare — it pins the field list explicitly, and a BATS test
> fails if that flag is ever removed.

Dry run (prints a summary, writes nothing) — the packaged form, with a curated
field list already applied:

```bash
npm run extract-fields                              # four fields: see note below
npm run extract-fields -- --facility=<facility-id>  # one facility
```

The `extract-fields` **npm wrapper** carries `--fields=capacityMw.operational,energy.source,energy.utility,water.coolingType`
(four fields, not two). The **nightly unattended lane** (`scripts/discovery/run.sh:579`) is correctly pinned to only
`capacityMw.operational,water.coolingType` — the two fields cleared by bench measurement.
The wrapper's four-field list includes `energy.source` and `energy.utility`, which are NOT flagged unsafe but
remain unmeasured (zero bench labels); a maintainer using the wrapper can capture them, but they route through
the staging gate like any unvetted field.

`npm run verify-fields` deliberately does NOT bake in a field list, because it only
re-checks values already recorded and writes nothing — the ship-safety caveat above
is about staging new values, so it does not apply there.

Equivalent long form, if you need a field list the wrapper doesn't cover:

```bash
npx tsx --env-file=.env.local scripts/discovery/extract-fields.ts \
  --fields capacityMw.operational,water.coolingType
```

Real run (stages candidates for review):

```bash
npx tsx --env-file=.env.local scripts/discovery/extract-fields.ts \
  --out /tmp/candidates.json --fields capacityMw.operational,water.coolingType
npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts /tmp/candidates.json
npm run submissions -- list pending
npm run submissions -- approve <id> "reviewed and verified"
```

**Flags:**
- `--out <path>` — write candidates to a file (omit for dry run)
- `--fields <list>` — comma-separated field names. **Defaults to all six fields, which is the unsafe set** — see the warning above; always pass it explicitly. An unknown name exits 1 rather than silently falling back to all six.
- `--limit N` — cap the run at N *gaps*, not N facilities. A gap is one missing field on one facility, so `--limit 100` with two fields requested covers roughly 50–67 facilities. Size runs accordingly.
- `--facility <id>` — restrict the run to one facility. Composes with `--limit` rather than overriding it: facilities are filtered first, then the gap cap still applies to what remains.
- `--run-id=<id>` — custom run ID (defaults to `track5-${timestamp}`)

Unknown field names exit 1 and print the valid list.

### Benchmark

`scripts/discovery/bench/` holds 69 real cached pages with hand-verified ground
truth: the original 31 are labeled for the four numeric fields, and all 69 are
labeled for `water.coolingType`. Current measured performance of the four numeric
fields (re-run scoring with `node scripts/discovery/bench/rescore.mjs`):

| Metric | Score |
|---|---|
| **PRECISION** | 90% |
| **RECALL** | 84% |
| **ABSTENTION-ACC** | 96% |
| Correct extractions | 26 |
| Correct abstentions | 80 |
| Misses | 5 |
| Wrong values | 0 |
| Hallucinations | 3 |

**Per field:**

| Field | Precision | Recall | Notes |
|---|---|---|---|
| `capacityMw.operational` | 100% | 100% | Strongest; safe to ship |
| `capacityMw.planned` | 75% | 67% | Weaker; review each |
| `energy.onSiteGenerationMw` | 50% | 100% | Weak precision; review each |
| `energy.source` | — | — | Enum (`grid`/`on_site_gas`/`nuclear`/…); extractable but not pinned (unmeasured) |
| `energy.utility` | — | — | Free-text string; extractable but not pinned (unmeasured) |
| `water.coolingType` | 95% | 95% | **Shipped and pinned** (the 6th extractable field) — measured 2026-09-01 over all 69 pages (18 correct, 45 correct abstentions, 1 wrong, 0 hallucinations). ⚠️ The score is 53%/42% if the prompt omits the decision rule, so it holds ONLY for a prompt that carries `docs/methodology.md#cooling-type` verbatim. `hybrid` is unmeasured (zero positive labels). |

The bench deliberately duplicates the shipped quote-gate logic (see
`scripts/discovery/bench/quote.mjs` vs. the gate in `extract-fields.ts`), and
`bench/quote-parity.test.ts` enforces they don't drift.

## Leads lane: closing the loop on public tips

`scripts/discovery/leads-lane.ts` takes anonymous public tips out of the `leads` table (`POST /api/leads`, staged `new` and reviewed at `/admin/leads`), researches each one with a local Ollama model, and stages the promising ones as `pending` `submissions` for the maintainer's normal human approve gate. Like field extraction, this is an operator tool — it never writes a live facility and never imports `lib/facility-write.ts`.

### What it does

For each `new` lead (oldest first):

1. Fetches the lead's URL. A fetch failure leaves the lead `new` — a bot-walled page is not a bad tip — and is not counted against it.
2. Asks the model to extract `name`, `operator`, `facilityType`, `status`, `city`, `state`, and `capacityMw`, explicitly instructed to return `null` for anything the page does not state. **The model never produces coordinates** — that field does not exist in the extraction schema at all.
3. If the extraction has no usable identity (`name`/`operator`/`state` all required), the lead moves to `researching` — a human should look. A lead is never `dismissed` automatically; only a human dismisses a lead.
4. Re-verifies the extracted name (plus any capacity figure, as a numeric hint) against the page via the same mechanical gate discovery submissions already use (`verify-source.ts`). Only a `"verified"` verdict proceeds. `"rejected"` (checked and it didn't hold up) moves the lead to `researching`. `"escalate"` (the fetcher couldn't structurally ingest the page) leaves the lead untouched at `new` for a human to look at from the normal queue — it is deliberately never treated as a rejection. `"unavailable"` (the model itself could not be reached) **aborts the entire run**, exactly like the discovery submission gate — never silently reclassified as "nothing found."
5. Geocodes the extracted `city, state` via `geocodeUS` (`lib/geocode.ts`) — coordinates are derived ONLY this way, never proposed by the model. Zero geocode results moves the lead to `researching`.
6. Builds the `create` payload in exactly the shape `buildCreatePayload` (`lib/contribute.ts`) produces — `confidence: "rumored"`, `location.precision: "approximate"`, the lead's URL as the source — and validates it against `facilitySchema` before ever calling `createSubmission`.
7. On success, `promoteLead` (`lib/leads.ts`) moves the lead to `promoted` and records the new submission id, in one write.

### Usage

```bash
# Real run (default) — processes up to 10 new leads.
npm run leads-lane

# Preview without writing anything.
npm run leads-lane -- --dry-run

# Process more leads in one pass, with a custom run id.
npm run leads-lane -- --limit=25 --run-id=manual-test
```

Needs a local Ollama daemon with `OLLAMA_VERIFY_MODEL` pulled, same as every other verification-gated discovery script. Unlike `submit-candidates.ts`, this lane talks to the database directly (via `lib/leads.ts`/`lib/submissions.ts`), not over HTTP — there is no public REST route for reading or mutating leads (the admin triage UI is session-gated Server Actions, unreachable from a standalone script), so run it with `--env-file=.env.local` for `DATABASE_URL`, matching `scripts/seed.ts`/`scripts/sync-to-neon.ts`.

### Safety properties

- **Staging-only, same invariant as the rest of discovery:** the only write
  paths are `createSubmission` (a `pending` row) and `promoteLead`/
  `updateLeadStatus` (moving a lead between `new`/`researching`/`promoted`).
  Nothing here ever writes a live facility.
- **A lead is never auto-dismissed.** The worst outcome an unpromising lead
  can reach on its own is `researching` — flagged for a human, never
  discarded. Only the admin triage UI's explicit dismiss action sets
  `dismissed`.
- **Fail-loud on an Ollama outage**, identical to `submit-candidates.ts`: any
  `"unavailable"` model response (extraction OR verification) throws and
  aborts the whole run rather than silently staging unverified leads or
  misreading an outage as "nothing found."
