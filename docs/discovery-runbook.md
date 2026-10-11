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

If the daemon is down or the model is not pulled, the gate returns `unavailable` and **nothing is staged** rather than submitting unverified candidates. This is deliberate: `unavailable` means "we could not check", never "the source is bad". The only opt-out is an explicit `VERIFY_SOURCES_ENABLED=false`.

⚠️ **"The run aborts" is imprecise, and the difference costs a session window** (found in the 2026-09-27 audit). `submit-candidates.ts` exits nonzero for the state it was working on — correct, nothing unverified reaches staging — but `run.sh` catches that exit, logs a WARN, appends to `FAILURES` and **continues to the remaining states**. So with Ollama down, a full sweep spends one `claude` invocation per remaining state and dies at the same gate each time, exhausting the session window on a run that structurally cannot stage anything. The safety property holds — nothing unverified is staged — but do not read the nonzero exit and the desktop notification as *telling you*: measured 2026-09-28, neither reliably reaches a person (see "Why off-machine?" below). The budget does not hold either. If you see the first state fail this way, stop the run by hand rather than letting it walk the list.

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

The job runs daily at 13:00 local, processing `STATES_PER_RUN` states per invocation (default 3 since 2026-10-09; it was 2 from 2026-08-14 — the rotation was expanded to all 50 states + DC on 2026-09-13 and the review cap raised 25 → 30, and `STATES_PER_RUN` was raised 2 → 3 on 2026-10-09 after zero overrun warnings since 2026-09-16; see `docs/discovery-pipeline.md` and the `STATES_PER_RUN` comment in `scripts/discovery/run.sh`) from a rotation cursor. It stays a no-op until you uncomment `DISCOVERY_ENABLED=true` (fail-closed by default).

Midday (rather than overnight) is deliberate: macOS `launchd` defers a missed `StartCalendarInterval` to the next wake, so an early-morning slot is simply skipped whenever the Mac is asleep. 13:00 assumes the machine is normally awake and lid-open then — if your usage differs, pick an hour when the Mac is reliably on, or move the job off the laptop entirely (e.g. a cron/CI runner with an API key instead of the subscription). Once a run *has* started, `run.sh` wraps the `claude -p` call in `caffeinate -i` (macOS only; a no-op elsewhere) so idle sleep can't suspend a long research call mid-run.

### PATH gotcha

launchd runs with a bare `PATH`, so the plist's `EnvironmentVariables` must list wherever `claude`/`node`/`npx` live (`/opt/homebrew/bin` on a Homebrew install). Without it the job cannot find them and fails in `discovery-logs/launchd.err`.

### Auth note

`claude -p` needs an authenticated Claude Code subscription session, and the CLI's own refreshable login is not durable enough for an unattended job: it expired **4 times in 9 days** (2026-09-26, 09-27, 10-03, 10-04), each time failing the batch until someone re-ran `claude` interactively. Headless runs should therefore use a **long-lived token** instead. `claude setup-token` mints a subscription token valid for about a year. `run.sh` fetches it from the macOS login keychain at the start of each live run and delivers it to the `claude` call only, over a one-shot **pipe file descriptor** (fd 3, named to the CLI by `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`) rather than through the environment. So no process holds it in its environment (not `timeout`, not `claude`, not the `npx`/`tsx` helpers); it is never on a command line where `ps` could show it; and it is never written to the log, `heartbeat.json`, any candidates file, or `bash -x` / `SHELLOPTS=xtrace` output.

Why a pipe and not `CLAUDE_CODE_OAUTH_TOKEN`: the headless session reads untrusted web pages and runs with sandboxed Bash, and a process's exec environment can be read by a sibling process of the same user (`sysctl KERN_PROCARGS2`), so an environment variable would be exposed to a prompt-injected Bash call even though Claude Code scrubs it from the Bash tool's own environment. `run.sh` also sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` alongside, as defence in depth across CLI versions.

⚠️ **Version-pinned.** `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` exists in the shipped CLI (2.1.288) but is **not** on the public environment-variables docs page. Since 2026-10-10 `run.sh` runs the token-present `claude` call under an **isolated config dir** (`DISCOVERY_CLAUDE_CONFIG_DIR`, default `~/.compute-atlas-discovery/claude-config`, mode 700), so the token **fully replaces** the stored login for that call: an invalid or expired keychain token makes the run fail loudly (classified `auth`, the batch short-circuits, the states are re-queued, the watchdog goes red) even when your interactive login is fine. With no token the call still uses the stored login, as before.

⛔ **Measured 2026-10-05 (CLI 2.1.288): the CLI reads the token but a valid stored login still authenticates.** A deliberately bogus token on fd 3 logged `Successfully read OAuth token from file descriptor 3`, then made one `/v1/messages` request with no 401. So before 2026-10-10 the token was never what authenticated a run.

✅ **Measured and fixed 2026-10-10 (CLI 2.1.294):** default config + bogus token on fd 3 returned a reply (stored login in `~/.claude` / keychain `Claude Code-credentials` wins); `CLAUDE_CONFIG_DIR=<fresh empty dir>` + no token returned `Not logged in`; the same empty dir + a bogus token returned `401 OAuth access token is invalid`. The token is honoured only when no stored login exists, hence the isolated config dir. Consequences: user-level `~/.claude` settings/hooks/MCP should no longer load for the headless call (inferred from `CLAUDE_CONFIG_DIR` semantics, **not measured**; tool permissions come from the explicit `CLAUDE_TOOL_FLAGS`), so CAST hook telemetry no longer records the discovery session, with the upside that the user-level CLAUDE.md/memory no longer contaminates the discovery prompt; and the keychain token minted 2026-10-05 itself returned **401 (invalid)** on 2026-10-10, so every stored-login lapse before the fix fell through to a dead token. Re-mint it (setup below). Re-test, which must 401:

```bash
CLAUDE_CONFIG_DIR=$(mktemp -d) CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 claude -p ok 3< <(printf '%s' sk-ant-oat01-bogus)
```

One-time setup (run these yourself, in a terminal):

```bash
claude setup-token                      # prints the token; copy it
security add-generic-password -U -a "$USER" -s compute-atlas-discovery-claude-token -w
# ^ -w is last on purpose: `security` prompts for the value, so the token never lands in shell history
pbcopy </dev/null                       # then clear the clipboard, and clear the terminal scrollback (Cmd-K)
```

(`-T /usr/bin/security` is not needed: the tool that creates an item is trusted to read it by default. That is not a restriction, though: **any process of your user that can run `/usr/bin/security` can read the item without a prompt**, including the headless session's sandboxed Bash tool, since the global settings grant a bare `Bash` allow plus `sandbox.autoAllowBashIfSandboxed` and the sandbox permits keychain access. See Residual risk below.)

Verify without printing it:

```bash
security find-generic-password -a "$USER" -s compute-atlas-discovery-claude-token >/dev/null && echo present
security find-generic-password -a "$USER" -s compute-atlas-discovery-claude-token -w | awk '{print length}'
```

The second line prints the stored length only. A token copied across a terminal line wrap stores a fragment: the first attempt on 2026-10-05 stored 13 characters, exactly the `sk-ant-oat01-` prefix. On 2026-10-10 two more fragments (78 and 99 characters) were stored and both returned 401; the working token was **108 characters**. Paste into an editor and join it to one line before storing.

A run logs `using long-lived Claude token from keychain item compute-atlas-discovery-claude-token` when it found the item and handed it to `claude` (the log names the item, never the value). Since 2026-10-10 the isolated config dir leaves the token as the call's only credential, so a run that authenticates after that line used the token; before then the line recorded delivery, not use.

**Residual risk.** A prompt-injected discovery session could read this item itself by running `security find-generic-password … -w` in its sandboxed Bash. That is the same exposure the CLI's own stored login (the `Claude Code-credentials` keychain item) already has today, so the token does not make it worse; and the pipe/descriptor delivery does not close it, because the session can go straight to the keychain. It is closed only by tightening the headless session's Bash permissions, which is an open maintainer decision (see the CORRECTION comment above `CLAUDE_TOOL_FLAGS` in `scripts/discovery/run.sh`). Creating the item is still optional (without it the job falls back to the stored login), but since 2026-10-10 it is what makes the job survive a login lapse.

- **The token expires about a year after you create it.** Note the creation date when you make it (a calendar reminder a month early works). Rotate by repeating the setup (`-U` updates the existing item). A lapsed token fails the run with `auth` (see the next bullet).
- **The item now displaces the stored login for the discovery call** (2026-10-10, via the isolated config dir; between 10-05 and 10-10 it did not). An expired, revoked or truncated token fails the run loudly with `auth`; the interactive login cannot rescue it. Fix by re-minting the token.
- **Remove** with `security delete-generic-password -a "$USER" -s compute-atlas-discovery-claude-token`.
- **Without the item** (or if `security` is unavailable), `run.sh` logs `no long-lived Claude token in keychain item …` and falls back to the CLI's stored login, the one that expires. That log line is the first thing to look for if auth failures return.
- **A hung keychain read is bounded.** `security` has no timeout of its own, so a locked keychain or an unanswered access prompt would otherwise stall the run; `run.sh` caps the read at 10 seconds (`DISCOVERY_KEYCHAIN_TIMEOUT_SECS`, needs a `timeout`/`gtimeout` binary), logs `WARN: keychain read … timed out`, and falls back to the stored login for that run.
- An expired login is classified `auth`, short-circuits the rest of the batch, and re-queues the states it consumed, so a lapse costs a day, not a state's turn in the rotation.
- `DISCOVERY_CLAUDE_TOKEN_SERVICE` overrides the keychain item name (the test suite uses it so it never touches the real item).

If authentication still fails from the background launchd context, `discovery-logs/launchd.err` is where it surfaces; the fallbacks are a login-session launcher or the manual invocation below.

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

An off-machine monitor in GitHub Actions detects when the local discovery pipeline has not run at all — the failure mode `run.sh` cannot self-detect, since it only fires when it runs — and, since 2026-09-28, when it ran and failed.

**Why off-machine?** macOS `StartCalendarInterval` does NOT catch up a missed run: if the machine is asleep/off at 13:00 local, the run simply never happens, and nothing on that machine errors (there's nothing there to error — the job never fired). `run.sh` documents this as its own blind spot — it cannot detect "launchd never fired at all" — and a watchdog on the same machine shares that blind spot exactly. A monitor running in GitHub Actions can detect this gap even if the Mac stays asleep indefinitely.

⚠️ **Do not treat `run.sh`'s local alerting as a second signal** (corrected 2026-09-28). This paragraph used to open by asserting that `run.sh` "already alerts on its own failures — desktop notification plus a nonzero exit". Both halves are unreliable, which is why the watchdog's scope widened (see **Scope** below):

- The notification is best-effort by construction, and through the outage it was unrecorded as well: both of `notify()`'s arms then ended in `>/dev/null 2>&1 || true`, so a failed send was indistinguishable from a delivered one and nothing recorded which happened, and the `DISCOVERY_NOTIFY` early return was a second, equally silent off-switch. `notify()` in `scripts/discovery/run.sh` was made legible on 2026-09-28: each arm's status is captured with `|| rc=$?` and every call logs one of four outcomes — `SUPPRESSED` (the `DISCOVERY_NOTIFY` early return at the top of `notify()`), `NO NOTIFIER on PATH`, `dispatched`, or `FAILED` — so `discovery-logs/launchd.out` now says which happened. ⚠️ That records **dispatch**, never delivery: `terminal-notifier` and `osascript` both exit 0 when Focus, Do Not Disturb or a revoked permission swallows the banner, so a `dispatched` line is not evidence a human was told. Legible best-effort is still not a second signal.
- The nonzero exit reaches only launchd, where it surfaces as the status column of `launchctl list` — a place nobody reads daily. Across the 2026-09-26..28 outage every run exited nonzero (each published `status="degraded"`) and that fact reached no one; the outage was found by a human noticing an absence of results.

The argument for an off-machine monitor above is unaffected — it never depended on the local alerting working.

**Mechanism:** `run.sh` writes `discovery-logs/heartbeat.json` after every run (successful or degraded). `run.sh` then publishes it to a `discovery_heartbeat` row in Neon, invoking `scripts/discovery/publish-heartbeat.ts` from inside the same non-dry-run heartbeat block — so `DISCOVERY_DRY_RUN=true` never writes to Neon. A publish failure does not abort the run (the discovery work is already complete by that point and must not be lost), but it is appended to `FAILURES`, so the run still exits nonzero and attempts the local notification — neither of which reaches a person reliably, per the caveat above. What a failed publish *does* do durably is leave the previous row in place to age: one missed publish leaves a row roughly a day old, still inside the default 36h threshold, so it takes two consecutive misses before the watchdog reports it stale. `publish-heartbeat.err` in `discovery-logs/` is where the reason is, and `npm run discovery:heartbeat` publishes one by hand. The `.github/workflows/discovery-watchdog.yml` workflow runs daily at 23:00 UTC (~5–6 hours after the 13:00-local scheduled run) and invokes `npx tsx scripts/discovery/check-heartbeat.ts`, which reads the `discovery_heartbeat` row from Neon and checks its freshness. It calls the script directly rather than the `check:heartbeat` npm script because that script carries `--env-file=.env.local`, which does not exist on a CI runner; there `DATABASE_URL` arrives from the workflow's job env.

**Fails closed:** The script exits nonzero if:
- `DATABASE_URL` is not set
- `DISCOVERY_STALE_HOURS` is set but unparseable as a positive number
- No `discovery_heartbeat` row exists (expected only before the first run after this feature's deploy; any other time means the publisher is broken)
- `last_run_at` is older than the configured threshold (default `DISCOVERY_STALE_HOURS=36`, deliberately matching `run.sh`'s own stale-check threshold so both agree on what "stale" means) — *no* run happened
- `last_run_at` is FRESH but the recorded status is not `"ok"` (added 2026-09-28) — a run *did* happen and it failed

Those last two are deliberately distinct error types (`HeartbeatStaleError` vs `HeartbeatDegradedError`) because their remedies share nothing: stale points at the schedule or the machine (launchd never fired), degraded points at that run's own output in `discovery-logs/` on the maintainer's Mac. Staleness is evaluated first, so a row that is both stale and degraded reports as stale.

A monitor that silently passes when it cannot check, or when the thing it is meant to detect (silence) has in fact occurred, is worse than no monitor — that is the exact gap this feature exists to close.

**Scope (widened 2026-09-28 — was freshness only):** Liveness **and** run quality — "did a discovery run happen recently" *and* "did it succeed". A fresh heartbeat recording `status != "ok"` now fails the watchdog; until 2026-09-28 it printed a warning and exited 0.

⚠️ **A manual run can redden the next scheduled watchdog.** There is one `discovery_heartbeat` row and every non-dry-run invocation overwrites it (the heartbeat block in `scripts/discovery/run.sh`, guarded by `if [[ "${DISCOVERY_DRY_RUN:-false}" != "true" ]]`), while a *single* entry in `FAILURES` is enough to set `status="degraded"` (`_hb_status` in that same block). So a hand-run that exhausts the Claude session window — or trips any other single failure — leaves a fresh degraded row behind, and the 23:00 UTC watchdog fails on it even though the scheduled pipeline is healthy. Check the run's own `discovery-logs/` before treating a `HeartbeatDegradedError` as a pipeline outage. To clear it before the next schedule you need a *successful* run to rewrite `discovery-logs/heartbeat.json` first — `npm run discovery:heartbeat` republishes whatever that file currently holds, so on its own it will re-publish the degraded row, not overwrite it. A dry run (`DISCOVERY_DRY_RUN=true`) never publishes at all and so never causes this. This is the cost of failing on degraded, and an operator who meets it unwarned learns to ignore the alert — which would undo the whole change.

Why it changed: the pipeline failed three days running and the watchdog reported `success` every time.

| Pipeline run | States | Output | Cause |
|---|---|---|---|
| 2026-09-26 | WI, IN | 73 B | `Failed to authenticate: OAuth session expired` |
| 2026-09-27 | OK, WY | 73 B | same |
| 2026-09-28 | NM, LA | 0 B | `claude` not on the launchd PATH (it had moved to `~/.local/bin`) |

Each of those runs published a perfectly **fresh** heartbeat (`status="degraded"`), so the freshness check passed and every scheduled watchdog run concluded `success` — an unbroken green streak across the outage and the fortnight before it (`gh run list --workflow=discovery-watchdog.yml`). **A pipeline that runs daily and fails daily is maximally fresh**, so freshness alone can never see it.

The old scope rested on one premise: that `run.sh` already alerted locally for degraded runs, so re-judging run quality here would only duplicate a signal someone was already getting. Nobody was getting it — see **Why off-machine?** above. An unverifiable local signal is not coverage, so the off-machine check now owns both questions.

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

Approving a submission whose facility has confirmed watchers emails them. That means an update's target, or a `create` that reuses a retired slug which still has watchers. `list pending` marks those rows, and `approve` refuses them (exit 2) unless you add `--notify-watchers`. The admin UI shows the same count and asks for confirmation.

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

> ⛔ **`--fields` is required.** `extract-fields.ts`'s own `parseArgs` now fails
> closed: omitting `--fields` (or passing it present-but-empty — `--fields=`, or a
> bare trailing `--fields`) throws immediately, naming the valid fields and a
> correct example invocation, rather than silently sweeping all six fields —
> including the two the bench measured as NOT safe to ship (`capacityMw.planned`
> P=75%, `energy.onSiteGenerationMw` P=50%; see the per-field table below). The
> pinned list is `capacityMw.operational`,
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
npm run extract-fields                              # two bench-measured fields — see note below
npm run extract-fields -- --facility=<facility-id>  # one facility
```

The `extract-fields` **npm wrapper** and the **nightly unattended lane** (`ENRICHMENT_FIELDS` in
`scripts/discovery/run.sh`) now pin the SAME two fields: `capacityMw.operational` and
`water.coolingType` — the only two cleared by bench measurement. Both lists are guarded by BATS
tests in `tests/discovery/run.bats`, each with negative assertions so an *appended* field is caught,
not just a replaced list.

> **Corrected 2026-09-11.** The wrapper previously carried a four-field list that also included
> `energy.source` and `energy.utility`, and this runbook argued that was acceptable. It was not:
> those two are **unmeasured** (zero bench labels), so the wrapper — the command a maintainer is
> most likely to type by hand — staged values into the review queue with an unknown error rate,
> while the scheduled job stayed correctly pinned. The convenient path was the unsafe one. If you
> find `package.json` and `run.sh` disagreeing again, the BATS guards are authoritative; do not
> "fix" one to match the other without re-reading this note.

The bare `npx tsx scripts/discovery/extract-fields.ts` invocation (no `--fields`) now **throws and
exits 1** instead of silently sweeping the full six-field default — the fail-open path that used to
include two fields that FAILED the bench (`capacityMw.planned` P=75%, `energy.onSiteGenerationMw`
P=50%) is closed. Always pass `--fields` explicitly for any ad hoc run regardless — the error message
tells you how. (Independent mitigating gates, unchanged: omitting `--out` is a dry run that writes
nothing, and reaching `pending` still requires piping the candidates file through
`submit-candidates.ts`, then a human approval.)

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
- `--fields <list>` — comma-separated field names. **Required** — see the warning above; omitting it (or passing it empty) exits 1 rather than silently falling back to all six. An unknown name also exits 1 rather than silently falling back to all six.
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

0. If the lead's triage (recorded at submit time) already lists live facilities citing its URL, the lead is deferred as a possible duplicate **before any fetch or model call**, with a note pointing at `/admin/leads`.
1. Fetches the lead's URL. A fetch failure leaves the lead `new` — a bot-walled page is not a bad tip — and is not counted against it.
2. Asks the model to extract `name`, `operator`, `facilityType`, `status`, `city`, `state`, and `capacityMw`, explicitly instructed to return `null` for anything the page does not state. **The model never produces coordinates** — that field does not exist in the extraction schema at all.
3. If the extraction has no usable identity (`name`/`operator`/`state` all required), the lead moves to `deferred` — a human should look. A lead is never `dismissed` automatically; only a human dismisses a lead.
4. Re-verifies the extracted name (plus any capacity figure, as a numeric hint) against the page via the same mechanical gate discovery submissions already use (`verify-source.ts`). Only a `"verified"` verdict proceeds. `"rejected"` (checked and it didn't hold up) moves the lead to `deferred`. `"escalate"` (the fetcher couldn't structurally ingest the page) leaves the lead untouched at `new` for a human to look at from the normal queue — it is deliberately never treated as a rejection. `"unavailable"` (the model itself could not be reached) **aborts the entire run**, exactly like the discovery submission gate — never silently reclassified as "nothing found."
5. Duplicate guard: if a live facility has the same operator in the same state, the lead moves to `deferred` with a note ("possible duplicate of <ids> — stage an update via /admin/leads") instead of proposing a second facility. The match is deliberately broad, since a false positive costs a human glance. A DB error in this query **aborts the run** (fail-closed); unlike a geocode error, it is not treated as a judgement about the lead.
6. Geocodes the extracted `city, state` via `geocodeUS` (`lib/geocode.ts`) — coordinates are derived ONLY this way, never proposed by the model. Zero geocode results moves the lead to `deferred`. A thrown geocode error (network/HTTP) leaves the lead `new` and the run continues. The request sends an identifying User-Agent (`LEADS_LANE_USER_AGENT`), because Nominatim returns 403 to Node's default one.
7. Builds the `create` payload in exactly the shape `buildCreatePayload` (`lib/contribute.ts`) produces — `confidence: "rumored"`, `location.precision: "approximate"`, the lead's URL as the source — and validates it against `facilitySchema` before ever calling `createSubmission`.
8. Stages the `pending` submission via `createSubmission`.
9. On success, `promoteLead` (`lib/leads.ts`) moves the lead to `promoted` and records the new submission id, in one write.

The lead also has a human path: `/admin/leads` offers "Stage as submission", which links the lead to a submission the same way. Each lead card then shows that submission's outcome (Pending / Approved <date> / Rejected <date>).

### Usage

**Nightly:** `scripts/discovery/run.sh` runs the leads lane every night after the field-extraction/verification block, with `LEADS_LIMIT` (default 10, validated as a positive integer). Its summary goes to `discovery-logs/leads-lane-<run-id>.json` and stderr to `leads-lane.err`. It is skipped on `DISCOVERY_DRY_RUN=true`. A non-zero exit (Ollama unavailable or a DB error) marks the run FAIL with "leads: lane failed" but does not stop the rest of the run.

Manual runs use the npm script:

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
  `updateLeadStatus` (moving a lead to `deferred`, or to `promoted`).
  ⚠️ The lane never writes `researching`: that status means "a human is
  actively working this lead" and is set only by the admin control. Its own
  give-up state is `deferred`, so the two are never confusable — and so a
  human can tell, from the status alone, that the machine already tried.
  Nothing here ever writes a live facility.
- **A lead is never auto-dismissed.** The worst outcome an unpromising lead
  can reach on its own is `deferred` — flagged for a human, never
  discarded. Only the admin triage UI's explicit dismiss action sets
  `dismissed`.
- **Fail-loud on an Ollama outage**, identical to `submit-candidates.ts`: any
  `"unavailable"` model response (extraction OR verification) throws and
  aborts the whole run rather than silently staging unverified leads or
  misreading an outage as "nothing found."
