# Discovery pipeline

[docs-destroy-ok]

A local, scheduled, subscription-powered pipeline that proposes candidate
facilities into the staging queue AND re-checks existing facilities
for genuine status changes. It NEVER writes live facilities — every candidate
(new or updated) lands as a `pending` row in `submissions`, reviewed and
approved/rejected by a human via the `submissions` CLI.

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
- `scripts/discovery/verify-source.ts`, `ollama-client.ts`, `fetch-page-text.ts`,
  `net-guard.ts` — the source verification gate. Before a candidate can be
  staged, its source URLs are fetched and mechanically checked against the
  claim using a local Ollama model. See "Source verification gate" below.
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

Each scheduled invocation does
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

## Source verification gate (local Ollama)

Every candidate source URL is fetched and mechanically checked against the claim
it is cited for before that candidate can become a `pending` submission. The
gate lives in `submit-candidates.ts` and is **on by default** — `verify-source.ts`
runs the check, `ollama-client.ts` talks to a local Ollama instance, and
`fetch-page-text.ts` (behind `net-guard.ts`) does the SSRF-guarded fetch.

**Why a local model.** Measured beforehand: a local model is unreliable at
*proposing* facts — 0/5 source URLs survived an open-ended discovery test, every
one fabricated — but strong at *checking* a grounded claim against fetched page
text (12/12). The gate only ever asks it to check a claim it has been handed,
never to propose one. Verification runs entirely on the machine; it never calls
a metered API.

### Configuration

All optional; defaults come from `ollama-client.ts`.

| Variable | Default | Notes |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | |
| `OLLAMA_VERIFY_MODEL` | `gpt-oss:20b` | must be pulled locally |
| `OLLAMA_TIMEOUT_MS` | `120000` | per-call abort timeout; used when it parses as a positive finite number, otherwise the default |
| `VERIFY_SOURCES_ENABLED` | gate is on | `false` is the only opt-out |

For installation and setup, see [discovery-runbook.md](./discovery-runbook.md).

### When Ollama is unreachable

If the daemon is down or the model is not pulled, the gate returns `unavailable`
and the run **aborts rather than submitting unverified candidates**. This is
deliberate: `unavailable` means "we could not check", never "the source is bad".
Collapsing the two would make an Ollama outage indistinguishable from a run that
caught a dozen fabrications. A `http_error_404` reason is the likeliest
real-world trigger — the model is not pulled (fresh machine, pruned model, or a
typo in `OLLAMA_VERIFY_MODEL`).

### Performance

Measured with `gpt-oss:20b` on Ollama 0.32.7, Apple Silicon:

- **~8–13s per verification call** — 8.4s at ~12k chars of page text, 12.6s at
  ~22.5k.
- **Parallelisation (default vs. tuned):** At the default `OLLAMA_NUM_PARALLEL=1`,
  Ollama serialises requests on the GPU, achieving only 1.04× speedup at 5-way
  concurrency — the overhead barely recoups fetch-bound gains. Setting
  `OLLAMA_NUM_PARALLEL=4` does raise throughput to ~1.25×–1.31×, but with a
  critical tradeoff: determinism breaks. At `temperature: 0`, identical input
  yields different answers when sharing a `-np 4` batch with other prompts —
  one extraction (`crane-pdx02`, `capacityMw.operational`) returned `48`
  consistently when run alone, but flipped to `null` roughly 1-in-6 in a
  concurrent batch. This reproducibility loss invalidates any benchmark and
  makes bulk runs unauditable. **Parallelism is not used for this reason.** If
  throughput ever binds, the answer is more machines or a smaller model, not
  higher concurrency.
- Page text is capped at `MAX_PAGE_TEXT_CHARS` (60,000) in `verify-source.ts`,
  coupled to the client's `num_ctx` of 32768 — **raising one requires revisiting
  the other.** Not cosmetic: submitting ~11,572 tokens at `num_ctx=2048` was
  measured to evict ~97% of the prompt, system prompt included, after which the
  model followed an instruction injected at the end of the page text.

### Known limitation: name matching, not entity resolution

The model matches names near-literally. Same page, same gate, only the entity
name changed: `springfieldohio.gov`'s "5C Data Center FAQs" page *verifies* the
name `5C Data Center` but *rejects* `5C Group / Vultr Data Center (Prime Ohio)`,
which is that facility's `name` in the dataset. A source that refers to a site by
a different name — subsidiary, tenant, project codename, operator rather than
site — can be rejected even though the citation is genuine. 241 of 937 records
(26%) carry composite names of that shape. Read gate output with that in mind: a
rejection is not proof that a citation is bad.

## Safety properties

- **Staging-only:** the pipeline only ever calls `POST /api/submissions`. It
  never calls `/api/facilities` and never edits `data/facilities.json`.
  Promotion to a live facility (new or updated) happens only via `npm run submissions --
  approve <id>`, a deliberate human action.
- **Fail-closed kill switch:** `run.sh` exits 0 immediately unless
  `DISCOVERY_ENABLED=true` is set in the environment, or if
  `discovery-logs/DISABLED` exists. The launchd plist deliberately does NOT
  set `DISCOVERY_ENABLED` — enabling it is a separate, deliberate step.
- **Bounded per run:** `STATES_PER_RUN` states per run (default 2) from the
  rotation cursor, each capped at `--max` candidates (new + updated combined).
  The cap is **per state**, and it **self-reverts**: 25/day for the first 20
  days from the burst-start date baked into `run.sh`, then automatically 15/day
  — no manual step to revert. It is a ceiling, not a target: observed yield is
  ~10 per state, so covering two states does not mean 50 rows. `MAX_CANDIDATES`
  in the environment overrides the computed cap (escape hatch / tests).
- **Fail-loud source verification:** every candidate's source URLs are fetched
  and mechanically checked against the claim before staging (see the gate
  above). If the local Ollama model is unreachable or not pulled, the check
  returns `unavailable` and the run **aborts** — it never falls back to
  submitting unverified candidates. `unavailable` means "we could not check",
  not "the source is bad"; the two are deliberately kept distinct so an Ollama
  outage can't look like a run that caught fabrications. The only opt-out is an
  explicit `VERIFY_SOURCES_ENABLED=false`.
- **No silent drops:** every skipped candidate (invalid schema, missing
  sources, duplicate, over cap, no genuine status change) is logged with a
  reason, both to stdout and to a JSON run summary in `discovery-logs/run-<runId>.json`.
- **Survives a session-limit / unparseable reply:** if the `claude -p` call
  exits nonzero (e.g. "You've hit your session limit") or returns no parseable
  JSON array, the run no longer crashes under `set -e` — it logs a WARN, skips
  the submit step (nothing to stage), still runs the source-liveness check, and
  records the outcome in the heartbeat below.
- **Heartbeat:** every real (non-dry-run) invocation writes
  `discovery-logs/heartbeat.json` — top-level `lastRunAt`, `status`
  (`ok` | `degraded`) and `failureCount`, plus a `states[]` array of
  `{ runId, state, claudeStatus, elapsedSecs }`. A stale `lastRunAt` means the
  daily job isn't running (a launchd sleep-skip or crash); `claudeStatus:
  no_array` means the run reached `claude` but got a session-limit/prose reply
  rather than candidates. A manual dry-run deliberately does not write the
  heartbeat, so it never masks a real launchd failure.
- **Alerting — the run tells you when it fails.** ⚠️ From 2026-08-08 to
  2026-08-14 the heartbeat recorded `claudeStatus: no_array` — total failure —
  **every day for six days and nothing surfaced it.** The instrument worked;
  nobody read it. A failed run and a perfect one were indistinguishable from
  outside: both logged, both wrote a heartbeat, both exited 0. Now any state
  that produces no parseable array, fails to submit, or overruns the wall-clock
  cap is recorded in a failure ledger, and at the very end of the run that
  ledger (a) fires a desktop notification via `terminal-notifier` (falling back
  to `osascript`) and (b) makes `run.sh` **exit 1**, so launchd records a failed
  run too. `DISCOVERY_NOTIFY=false` suppresses only the notification.
  The alert is deliberately the *last* thing in the script — after submit,
  source-liveness and heartbeat — so it can never cost the run work it would
  otherwise have completed. A clean run stays silent and exits 0; an alert that
  fires on healthy runs would train you to ignore it, which is the original bug.
  **Residual gap (known):** this only fires when `run.sh` actually runs. It
  cannot detect "launchd never fired at all" — that needs a separate watchdog
  job. The stale-heartbeat check is the partial mitigation: on startup, a
  previous `lastRunAt` older than `DISCOVERY_STALE_HOURS` (default 36) is
  reported and notified, so missed days surface on the next run that happens.
- **The wall-clock cap is enforced, and its failure is detected.**
  `DISCOVERY_TIMEOUT_SECS` (default 3000) is passed to `timeout` together with
  `-k DISCOVERY_KILL_AFTER_SECS` (default 120), which escalates to SIGKILL.
  This matters: **measured on macOS, `timeout 2` against a process that ignores
  SIGTERM let it run the full 31s and still exited 124** — so `-k` is what
  actually enforces, and exit status 124 can never prove the cap worked.
  Because of that, every `claude` invocation is also timed, and a run whose
  wall-clock exceeds `cap + kill-after + DISCOVERY_OVERRUN_GRACE_SECS`
  (default 60) is flagged as a cap-enforcement failure. That is the only way to
  catch the machine-sleep case, where macOS pauses `ITIMER_REAL` and *both*
  timers stop counting — observed 2026-08-11/12 as 106-minute runs against a
  600s cap. Note a run can produce perfectly valid candidates and *still* be
  flagged: an overrun is a failure of the guard, not of the output.
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

**Cadence:** The combined-pass model runs daily via launchd, processing
`STATES_PER_RUN` states per invocation (default 2) from a rotation cursor.

**Rotation (rebalanced 2026-08-14).** The rotation was 15 states holding 555 of
941 live facilities — meaning **386 facilities lived in states the pipeline
never visited**, and so were never re-checked, never enriched, never deepened.
IA, NE, WA, OR, MN, MO and UT are major hyperscaler markets that were sitting at
8–26 records with zero pipeline attention, so they now lead the rotation.
Nothing was removed: dropping the saturated states (TX at 106, VA at 110) would
have silently stopped re-checking their facilities for status changes. 22 states
at 2 per run cycles in about 11 days, up from 7.5 — the deliberate cost of not
losing re-check coverage.

`DISCOVERY_STATES` overrides the rotation entirely (space-separated). That is
the supported way to drive a targeted run without editing the script, and it is
what the BATS suite pins so cursor tests survive the next rebalance.

## Field extraction from existing sources

`scripts/discovery/extract-fields.ts` fills missing structured fields on
*existing* facilities by re-reading sources those facilities already cite,
using a local Ollama model. This is an enrichment tool, not a discovery tool —
it never proposes new facilities and it never overwrites a curated value.

### Provenance and review workflow

Every candidate carries `provenance.note` with the format:
```
field=value (quote: "…", source: <url>)
```

This metadata is what makes the `pending`-queue review fast enough to work —
human reviewers see exactly which quote backed which value. The note must not
be stripped; a real reviewed example shows the problem it solves: a candidate
proposed `capacityMw.operational = 25` from a quote reading "permitted … up to
75 MW, yet … as low as 25 MW" — a genuine figure, but the wrong field. That was
caught in seconds only because the quote travelled with the value.

### Screening rules

- **`>= 500 MW` on a `data_center`** is flagged for human review (flag in
  `provenance.note` as `REVIEW: ...`), not an alarm. Of 854 live data centers,
  108 already exceed 500 MW, so this is a routine queue item, not a red flag.

### Known limits and caveats

- **Yield figures:** A prior 100-gap run measured ~9% fill rate and concluded
  most remaining gaps are real absences rather than unmined data. This is
  **provisional** — two defects found during shipping undermine that conclusion.
  A Unicode-dash bug meant pages whose only capacity figure used an en/em dash
  were silently skipped, and a separate fetch failure caused a full sweep to
  report 1455 of 1545 gaps as unfetchable. Do not cite the older "5,650 field-gaps"
  headline — it is retracted. Re-run a sweep before drawing yield conclusions.
- **Enum fields** (`energy.source`, `energy.utility`): the bench covers only
  numeric fields. Enum extraction is not measured and should be treated as alpha.
- **No batching:** asking for several fields in one model call was measured at
  2/7 recall against 4/4 for one-field-per-call. The reason is recall, not
  determinism — do not conflate this with the `OLLAMA_NUM_PARALLEL`
  reproducibility finding above, which is a separate result about concurrency.

For usage, benchmark, and operational details, see [discovery-runbook.md](./discovery-runbook.md).

## Running the pipeline

For day-to-day operations, including running manually, installing the launchd job, and reviewing submissions, see [discovery-runbook.md](./discovery-runbook.md).

## Leads lane

For details on the leads lane tool (`scripts/discovery/leads-lane.ts`), see [discovery-runbook.md](./discovery-runbook.md).
