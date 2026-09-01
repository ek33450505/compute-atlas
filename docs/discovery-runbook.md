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
> default" — it means all five fields, including the two the bench measured as NOT
> safe to ship (`capacityMw.planned` P=75%, `energy.onSiteGenerationMw` P=50%; see
> the per-field table below). The three benched-safe fields are
> `capacityMw.operational`, `energy.source`, `energy.utility`. The `npm run`
> wrapper below bakes that list in so it cannot be forgotten; treat a bare
> `extract-fields.ts` invocation as an operator error. The nightly `run.sh` lane is
> scheduled, but never bare — it pins the field list explicitly, and a BATS test
> fails if that flag is ever removed.

Dry run (prints a summary, writes nothing) — the packaged form, with the safe
field list already applied:

```bash
npm run extract-fields                              # all gaps, safe fields only
npm run extract-fields -- --facility=<facility-id>  # one facility
```

The `extract-fields` script entry carries `--fields=capacityMw.operational,energy.source,energy.utility`;
`npm run verify-fields` deliberately does NOT bake in a field list, because it only
re-checks values already recorded and writes nothing — the ship-safety caveat above
is about staging new values, so it does not apply there.

Equivalent long form, if you need a field list the wrapper doesn't cover:

```bash
npx tsx --env-file=.env.local scripts/discovery/extract-fields.ts \
  --fields capacityMw.operational,energy.source
```

Real run (stages candidates for review):

```bash
npx tsx --env-file=.env.local scripts/discovery/extract-fields.ts \
  --out /tmp/candidates.json --fields capacityMw.operational,energy.source
npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts /tmp/candidates.json
npm run submissions -- list pending
npm run submissions -- approve <id> "reviewed and verified"
```

**Flags:**
- `--out <path>` — write candidates to a file (omit for dry run)
- `--fields <list>` — comma-separated field names. **Defaults to all five fields, which is the unsafe set** — see the warning above; always pass it explicitly. An unknown name exits 1 rather than silently falling back to all five.
- `--limit N` — cap the run at N *gaps*, not N facilities. A gap is one missing field on one facility, so `--limit 100` with two fields requested covers roughly 50–67 facilities. Size runs accordingly.
- `--facility <id>` — restrict the run to one facility. Composes with `--limit` rather than overriding it: facilities are filtered first, then the gap cap still applies to what remains.
- `--run-id=<id>` — custom run ID (defaults to `track5-${timestamp}`)

Unknown field names exit 1 and print the valid list.

### Benchmark

`scripts/discovery/bench/` holds 31 real cached pages × 4 fields with
hand-verified ground truth. Current measured performance (re-run scoring with
`node scripts/discovery/bench/rescore.mjs`):

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
| `energy.source` | — | — | Enum (`grid`/`on_site_gas`/`nuclear`/…); not bench-scored |
| `energy.utility` | — | — | Free-text string; not bench-scored |

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
