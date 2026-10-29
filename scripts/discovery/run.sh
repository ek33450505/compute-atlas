#!/usr/bin/env bash
# Scheduled harness for the discovery pipeline. Fail-closed by default: does
# nothing unless DISCOVERY_ENABLED=true. Never writes live facilities — the
# submit step only ever POSTs to /api/submissions (the staging queue),
# and the discovery step itself is read-only research. Never git commits or
# pushes. Intended to be run by launchd (see com.compute-atlas.discovery.plist)
# or manually for testing.
set -euo pipefail

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
}

# validate_positive_int_env: coerce an env-overridable limit to a positive
# integer, falling back to a documented default when it isn't one.
#
# Why this exists (fail-open hazard, verified): bash's ${VAR:-default} only
# substitutes when VAR is UNSET or EMPTY. A malformed-but-non-empty value
# (e.g. ENRICHMENT_LIMIT=abc) passes straight through to --limit=abc.
# extract-fields.ts and verify-fields.ts both parse an unparseable --limit as
# `undefined`, and an undefined limit means the bounding gaps.slice(0, limit)
# is SKIPPED ENTIRELY — turning a ~60-value bounded lane into an unattended
# sweep of ~2,190 gap values (measured 2026-09-01 via selectGaps()), roughly
# 10 hours of third-party-source crawling (proportional rescale of the
# previously measured 12h/2,525-gap figure to the current 2-field gap
# count — not a fresh measurement).
# This matters specifically because this lane now runs unattended
# via launchd, not by hand: a hand-run operator would see the runtime blow
# up and kill it; a scheduled job will not. submit-candidates.ts already
# guards this exact bug class for its own --max (see the `--max=` clamp in
# its parseArgs()); extract-fields.ts and verify-fields.ts do not, which is
# why the guard belongs here at the call site.
#
# Usage: result="$(validate_positive_int_env VAR_NAME default_value)"
validate_positive_int_env() {
  local var_name="$1" default_val="$2" val
  val="${!var_name:-}"
  if [[ -z "$val" ]]; then
    val="$default_val"
  elif [[ ! "$val" =~ ^[1-9][0-9]*$ ]]; then
    # Callers capture this function's stdout via $(...) to get the validated
    # value, so the WARN must go to stderr — a stdout WARN would splice into
    # the captured value itself and corrupt it.
    log "WARN: ${var_name}=${val} is not a positive integer — falling back to default ${default_val}" >&2
    val="$default_val"
  fi
  printf '%s' "$val"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="${DISCOVERY_LOG_DIR:-$REPO_ROOT/discovery-logs}"
mkdir -p "$LOG_DIR"

# --- fail-closed kill switch -------------------------------------------------
if [[ "${DISCOVERY_ENABLED:-false}" != "true" ]] || [[ -f "$LOG_DIR/DISABLED" ]]; then
  log "discovery disabled — skipping"
  exit 0
fi

# --- alerting ----------------------------------------------------------------
# 2026-08-14 open item #1: heartbeat.json recorded claudeStatus=no_array every
# day for SIX consecutive days and nothing surfaced it. The instrument worked
# perfectly; nobody read it. A silent instrument is not monitoring. So every
# failure path below now does two things, neither of which reliably reaches a
# person on its own:
#   1. ATTEMPTS a local desktop notification (terminal-notifier, else
#      osascript) and logs the outcome of the attempt — an attempt is not a
#      delivery; see notify() below for why a zero exit proves nothing
#   2. makes this script exit NONZERO, so launchd records a failed run too
# DISCOVERY_NOTIFY=false disables (1) for tests/CI. Notification is strictly
# best-effort: its exit status is captured and logged, never propagated, so it
# can never fail the pipeline.
# The DURABLE signal is neither of the above: it is the discovery_heartbeat row
# published to Neon and read off-machine by .github/workflows/discovery-watchdog.yml,
# which since 2026-09-28 fails on a DEGRADED run as well as a missing/stale one.
#
# RESIDUAL GAP (deliberate, documented): this only fires when run.sh actually
# RUNS. It cannot detect "launchd never fired at all" — that needs a separate
# watchdog job. The stale-heartbeat check below is the partial mitigation: it
# reports missed days on the next run that does happen.
#
# notify() never lets a NOTIFIER fail the run: each arm's exit status is
# captured with `|| rc=$?` and logged rather than propagated, and the function
# ends in `return 0`. That is a claim about the notifiers, not a guarantee the
# function cannot exit — log() is unguarded here exactly as it is everywhere
# else in this script, and under `set -euo pipefail` a failing log() would end
# the run wherever it is called. What changed is that notify() is no longer
# SILENT: every outcome is written through log() so a post-hoc reader of
# discovery-logs/launchd.out can tell which of four things happened —
# suppressed, no notifier on PATH, dispatched, or the notifier errored.
#
# ⚠️ WORDING IS LOAD-BEARING: these lines say "dispatched", never "delivered".
# A zero exit from terminal-notifier/osascript proves only that the binary was
# invoked and returned success. macOS Focus modes, Do Not Disturb and revoked
# notification permissions all swallow the banner silently and still exit 0, so
# a green "dispatched" line is NOT evidence that a human was told. Reading it
# as proof of delivery is the exact overclaim the Sep 2026 three-day silent
# outage was made of.
#
# 📌 REFERENCING CONVENTION (2026-09-28): cite this function as `notify()`, never
# by line number. A line number in prose is a dependency with no compiler — tsc
# catches a broken import, nothing catches a broken `run.sh:101-136`. Anchors
# pointing here went stale THREE times in one session, once while two agents were
# fixing them concurrently, so a correction went stale during the act of
# correcting it. Names move with the code; line numbers do not. Keep a line
# number only when there is nothing nameable to point at, and then say what it
# points at.
notify() {
  local title="$1" message="$2" safe_title safe_message rc
  # Strip quotes/backslashes/newlines — these strings are interpolated into an
  # AppleScript string literal below, and state/run-id values reach them.
  # (Also keeps each log line below to a single line.)
  safe_title="$(printf '%s' "$title" | tr -d '"\\' | tr '\n' ' ')"
  safe_message="$(printf '%s' "$message" | tr -d '"\\' | tr '\n' ' ')"
  if [[ "${DISCOVERY_NOTIFY:-true}" != "true" ]]; then
    log "notify: SUPPRESSED (DISCOVERY_NOTIFY=${DISCOVERY_NOTIFY:-true}) — $safe_title: $safe_message"
    return 0
  fi
  # set -e is in force, so capture the status with `|| rc=$?` — immediately,
  # and never through a pipe (a pipeline has silently replaced an exit status
  # in this repo before).
  rc=0
  if command -v terminal-notifier >/dev/null 2>&1; then
    terminal-notifier -title "$safe_title" -message "$safe_message" \
      -group com.compute-atlas.discovery >/dev/null 2>&1 || rc=$?
    if [[ "$rc" -eq 0 ]]; then
      log "notify: dispatched via terminal-notifier (exit 0; dispatched != seen) — $safe_title: $safe_message"
    else
      log "notify: FAILED via terminal-notifier (exit $rc) — $safe_title: $safe_message"
    fi
  elif command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$safe_message\" with title \"$safe_title\"" \
      >/dev/null 2>&1 || rc=$?
    if [[ "$rc" -eq 0 ]]; then
      log "notify: dispatched via osascript (exit 0; dispatched != seen) — $safe_title: $safe_message"
    else
      log "notify: FAILED via osascript (exit $rc) — $safe_title: $safe_message"
    fi
  else
    log "notify: NO NOTIFIER on PATH (neither terminal-notifier nor osascript) — $safe_title: $safe_message"
  fi
  return 0
}

# --- stale-heartbeat check ---------------------------------------------------
# Reads the PREVIOUS run's heartbeat before this run overwrites it. A gap wider
# than DISCOVERY_STALE_HOURS means scheduled runs were missed entirely (machine
# asleep at 13:00, job unloaded, plist broken) — a different failure than "the
# run happened and produced nothing", and invisible from claudeStatus alone.
DISCOVERY_STALE_HOURS="${DISCOVERY_STALE_HOURS:-36}"
if [[ -f "$LOG_DIR/heartbeat.json" ]]; then
  _prev_iso="$(sed -n 's/.*"lastRunAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$LOG_DIR/heartbeat.json" | head -1)"
  if [[ -n "$_prev_iso" ]]; then
    # BSD (macOS) then GNU (Linux/CI); either failing leaves _prev_epoch empty
    # and the check is skipped rather than guessed at.
    _prev_epoch="$(date -j -f '%Y-%m-%dT%H:%M:%S%z' "$_prev_iso" '+%s' 2>/dev/null \
      || date -d "$_prev_iso" '+%s' 2>/dev/null || echo '')"
    if [[ -n "$_prev_epoch" ]]; then
      _gap_hours=$(( ( $(date '+%s') - _prev_epoch ) / 3600 ))
      if (( _gap_hours > DISCOVERY_STALE_HOURS )); then
        log "WARN: previous discovery run was ${_gap_hours}h ago (> ${DISCOVERY_STALE_HOURS}h) — scheduled runs were MISSED, not merely unproductive"
        notify "Compute Atlas discovery" "Missed runs: last completed run was ${_gap_hours}h ago"
      fi
    fi
  fi
fi

# --- state rotation cursor ---------------------------------------------------
# Rebalanced 2026-08-14: the previous 15-state rotation held 555 of 941 live
# facilities, leaving 386 in states the pipeline NEVER visited — never
# re-checked, never enriched, never deepened. IA/NE/WA/OR/MN/MO/UT are major
# hyperscaler markets sitting at 8-26 records with zero pipeline attention, so
# they lead the rotation now. Nothing was REMOVED: dropping TX/VA would have
# stopped re-checking their 216 facilities. 22 states at 2/run cycles in 11
# days (was 7.5) — the cost of not losing re-check coverage.
#
# Expanded 2026-09-13 to all 50 states + DC (51 tokens, derived from
# lib/us-states.ts's US_STATE_NAMES — the repo's single source of truth for
# state codes). The prior 22 stay in their existing order at the FRONT and the
# 29 never-swept states are appended after: the cursor file ($LOG_DIR/cursor.txt)
# holds a state CODE, not an index, so preserving the existing prefix means the
# live cursor stays valid and the rotation doesn't restart or skip anything —
# re-sorting the whole list would relocate the cursor mid-cycle. The 29
# appended states are the higher-yield half of this change: a flat
# `lastUpdated` in one of the original 22 means the pipeline looked and found
# nothing, but in one of these 29 it means nobody has ever looked.
#
# DISCOVERY_STATES overrides the list entirely (space-separated). That is the
# supported way to drive a targeted manual run without editing this file:
#   DISCOVERY_STATES="IA NE" STATES_PER_RUN=2 bash scripts/discovery/run.sh
DEFAULT_STATES="IA NE WA OR MN MO UT TX VA OH GA AZ NV NC PA IL WI IN OK WY NM LA AL AK AR CA CO CT DC DE FL HI ID KS KY ME MD MA MI MS MT NH NJ NY ND RI SC SD TN VT WV"
read -r -a STATES <<< "${DISCOVERY_STATES:-$DEFAULT_STATES}"
# True only when STATES IS the default rotation. The re-queue rewind after the
# state loop writes a state into cursor.txt, and an override-list state must
# never land there (a targeted `DISCOVERY_STATES="IA NE"` run would plant a
# state the live rotation may not even contain).
ROTATION_IS_DEFAULT=false
if [[ -z "${DISCOVERY_STATES:-}" ]]; then
  ROTATION_IS_DEFAULT=true
fi
if (( ${#STATES[@]} == 0 )); then
  log "WARN: DISCOVERY_STATES was set but empty — falling back to the default rotation"
  read -r -a STATES <<< "$DEFAULT_STATES"
  ROTATION_IS_DEFAULT=true
fi
CURSOR_FILE="$LOG_DIR/cursor.txt"

# STATES_PER_RUN: how many states this invocation processes, each with its own
# claude call/submit. Default 3 (2026-10-09; was 2 from 2026-08-14, a ~3x
# daily-output push). Env-overridable for tests/tuning. Clamped to
# [1, ${#STATES[@]}] so a bad value (0, negative, or bigger than the rotation)
# can't loop forever or index out of STATES' bounds.
#
# History: it was deliberately NOT raised alongside the 2026-09-13 rotation
# expansion to 51 states (see DEFAULT_STATES above) — that would have stacked
# an unmeasured throughput change on top of an unmeasured 2.3x scope change in
# the same commit, making any regression unattributable to either. The lever
# then was STEADY_CAP (raised 25 -> 30 below). The wall-clock cap was known NOT
# to reliably enforce (see the OVERRUN_LIMIT_SECS note below — overruns of
# 6399s/4232s/5456s against a 3000s cap, 2026-08-15), and a mid-batch death
# (machine sleep or subscription session limit, both observed) costs every
# remaining state in the batch.
#
# Raised 2 -> 3 on 2026-10-09 (Ed's decision) after measuring
# discovery-logs/launchd.out: zero OVERRUN warnings logged since 2026-09-16, no
# session-limit hits, and 2-state batches took 68-118 min (so 3 states should
# take roughly 100-175 min). The 51-state rotation has run ~4 weeks. The
# 2026-10-05..10-07 failures were an expired Claude login, not load. If
# OVERRUN warnings or session-limit hits return, this is the first lever to
# revert.
#
# Rotation arithmetic: 51 states / 3 per day = exactly a 17-day full cycle
# (was ~26 days at 2 per day, and 11 days at 22 states / 2 before the
# 2026-09-13 expansion). Unlike 2, 51 DOES divide evenly by 3, so the same
# triples of states recur together every cycle rather than shifting — a
# consequence worth knowing, not a bug.
STATES_PER_RUN="${STATES_PER_RUN:-3}"
(( STATES_PER_RUN < 1 )) && STATES_PER_RUN=1
(( STATES_PER_RUN > ${#STATES[@]} )) && STATES_PER_RUN=${#STATES[@]}

if [[ -f "$CURSOR_FILE" ]]; then
  CURRENT_STATE="$(cat "$CURSOR_FILE" | tr -d ' \n')"
else
  CURRENT_STATE=""
fi

CURRENT_INDEX=0
if [[ -n "$CURRENT_STATE" ]]; then
  for i in "${!STATES[@]}"; do
    if [[ "${STATES[$i]}" == "$CURRENT_STATE" ]]; then
      CURRENT_INDEX="$i"
      break
    fi
  done
fi

# Select STATES_PER_RUN consecutive states starting at the cursor, wrapping
# modulo ${#STATES[@]}. STATES_PER_RUN is clamped above to at most the number
# of states, so these offsets (0..STATES_PER_RUN-1 mod length) are always
# distinct — the batch can never contain the same state twice.
BATCH_STATES=()
for (( _n = 0; _n < STATES_PER_RUN; _n++ )); do
  _idx=$(( (CURRENT_INDEX + _n) % ${#STATES[@]} ))
  BATCH_STATES+=("${STATES[$_idx]}")
done

# Cursor advance is written ONCE, before any research work below, so a crash
# mid-batch cannot make the rotation stick on the same states forever.
NEXT_INDEX=$(( (CURRENT_INDEX + STATES_PER_RUN) % ${#STATES[@]} ))
echo "${STATES[$NEXT_INDEX]}" > "$CURSOR_FILE"

log "starting discovery batch for states=${BATCH_STATES[*]} (STATES_PER_RUN=$STATES_PER_RUN)"

if [[ "${DISCOVERY_DRY_RUN:-false}" != "true" ]]; then
  # Batch-mode contract, appended at the SYSTEM level so it outranks any
  # user-global ~/.claude persona (e.g. a journal rule or chatty-summary habit)
  # this headless session would otherwise inherit. On 2026-07-15 the AZ run
  # inherited that persona, ended its turn with a prose summary + journal write
  # instead of the JSON array, and the submit step then parsed zero candidates.
  # ASCII-only on purpose: launchd runs with a bare/C locale.
  BATCH_CONTRACT="You are a non-interactive batch data extractor. Your ENTIRE response MUST be exactly one raw JSON array and nothing else: no prose, no markdown fences, no preamble, no session summary, and you must NOT write any journal entry or edit any files. The final character you output must be ]."

  # macOS ships neither `timeout` nor `gtimeout`, so the old `command -v timeout`
  # check always fell through to the uncapped branch here — a run that stalled
  # (e.g. claude suspended across a sleep) then had no wall-clock cap at all.
  # Prefer whichever timeout binary exists; if none, run uncapped but say so.
  TIMEOUT_BIN=""
  if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN="gtimeout"
  fi

  # Wall-clock cap for EACH state's claude call, overridable for tests/tuning.
  # 2026-08-09 regression: historical successful runs took 420-510s against a
  # hardcoded 600s cap (Aug 6=420s, Aug 7=489s, Aug 5/8=~510s) — right at the
  # edge. It tipped over: timeout sent SIGTERM, claude emitted an
  # error_during_execution result, and the literal 15-byte string
  # "Execution error" landed in the candidates file, so candidates_file_shape
  # below found no array and submit was silently skipped for every run since.
  # Raised well above the observed ceiling so the same margin doesn't erode again.
  DISCOVERY_TIMEOUT_SECS="${DISCOVERY_TIMEOUT_SECS:-3000}"

  # `timeout` alone is NOT a guarantee — MEASURED 2026-08-14. Against a process
  # that ignores SIGTERM, `timeout 2` let it run the full 31s and STILL exited
  # 124; with `-k 3` it died at 5s and exited 137. Two consequences encoded here:
  #   1. -k/--kill-after escalates to SIGKILL, which is the actual enforcement.
  #   2. Exit code 124 does NOT prove the cap enforced, so it cannot be used to
  #      detect a cap that failed. Only wall-clock can — hence the elapsed
  #      measurement below and the overrun check at the call site.
  # This does NOT close the machine-sleep case: on macOS `timeout`'s ITIMER_REAL
  # is paused across system sleep, so BOTH the initial timer and the kill-after
  # timer stop counting. That is why the overrun check exists rather than being
  # replaced by -k. (Observed 2026-08-11/12: runs of 106 min against a 600s cap,
  # concurrent with check-sources reporting error=3258 — every source failing,
  # i.e. no network, the sleep signature.)
  DISCOVERY_KILL_AFTER_SECS="${DISCOVERY_KILL_AFTER_SECS:-120}"

  # Wall-clock beyond which the cap demonstrably did not enforce: the cap, plus
  # the kill-after escalation, plus process-teardown grace. The grace is
  # env-overridable ONLY so the BATS suite can probe this detector in seconds
  # instead of 60+ — a detector that cannot be exercised in a test is exactly
  # the kind of instrument this whole change exists to stop trusting.
  DISCOVERY_OVERRUN_GRACE_SECS="${DISCOVERY_OVERRUN_GRACE_SECS:-60}"
  OVERRUN_LIMIT_SECS=$(( DISCOVERY_TIMEOUT_SECS + DISCOVERY_KILL_AFTER_SECS + DISCOVERY_OVERRUN_GRACE_SECS ))

  # caffeinate (macOS only) prevents idle sleep from suspending the claude
  # call mid-run (see the timeout-binary comment above re: "claude suspended
  # across a sleep"). Absent on Linux/CI — CAFFEINATE_PREFIX stays an empty
  # array, a no-op. Expanded via the bash-3.2-safe "${arr[@]+"${arr[@]}"}"
  # idiom below so `set -u` never trips on an empty array on macOS's stock
  # bash 3.2 (the launchd host).
  CAFFEINATE_PREFIX=()
  if command -v caffeinate >/dev/null 2>&1; then
    CAFFEINATE_PREFIX=(caffeinate -i)
  fi

  # Tool grants for the headless session. Control validity MEASURED on Claude
  # Code CLI 2.1.308 (2026-10-27); re-probe after CLI upgrades.
  # `claude -p` has no human to approve a permission prompt, so anything not
  # granted auto-denies; WebFetch/WebSearch/Read/Glob/Grep are granted for the
  # pipeline's core need (fetch and cite real sources). Shell access exists for
  # one reason: archive.org/CDX and other bot-walled sources WebFetch cannot
  # reach (Responsibility 4). It is therefore limited to the one-URL GET-only
  # wrapper fetch-url.sh, NOT `Bash(curl:*)`: a probe showed the allowlisted
  # `curl -d @file` / `-F f=@file` uploaded files from outside the cwd even
  # though Read/cat there were blocked. With the wrapper grant, raw curl needed
  # approval (denied in -p). Overpass POSTs with `--data-urlencode` are no longer
  # possible (a GET `?data=` form is UNVERIFIED).
  # Compound commands are NOT blocked wholesale: each part is checked on its
  # own. MEASURED 2026-10-27: read-only parts such as `echo` and `whoami`,
  # including inside `$(...)` or backticks in the wrapper's argument, DID
  # execute; `python3`, `env`, `printenv` required approval (denied); `$VAR`
  # expansion, a standalone `ps eww -A` and `> file` redirection never executed (the session
  # stalled on them until timeout). Consequence: claude's environment must hold
  # NO secrets, and run.sh must never export one. The repo template
  # scripts/discovery/com.compute-atlas.discovery.plist sets only PATH (the other
  # two are commented out); the INSTALLED LaunchAgents plist (read with
  # `plutil -p` on 2026-10-27) sets API_BASE_URL, DISCOVERY_ENABLED and PATH.
  # Neither holds a secret.
  # Boundary: the session can still run read-only commands that need no path
  # argument (`whoami`, `date`, `uname` ...) inside `$(...)`, and their output can
  # reach the GET URL. So no secret may live in claude's environment OR in any
  # process's argv. MEASURED 2026-10-27: `$(ps -ef)` and `$(lsof -p 1)` inside the
  # wrapper argument executed (that probe's GET did not reach the listener:
  # fetch-url.sh exited 2 with its 'only a single http(s) URL' error); with
  # Bash(ps/pgrep/lsof) in --disallowedTools, `$(ps -ef | ...)` and
  # `$(pgrep -lf ...)` were denied immediately, which also avoids the headless
  # stall. Those deny rules match the command NAME only: path-qualified or
  # wrapped forms (`/bin/ps`, `command ps`, `\ps`) are UNMEASURED and may not be
  # covered, so the deny list is defence in depth and the boundary is the
  # no-secrets-in-env-or-argv invariant.
  # Hardening layers:
  #  - `--restricted`: per `claude --help` (2.1.308) it ignores user, project and
  #    local settings files while managed settings still apply. Why it matters:
  #    the 2026-10-27 transcript analysis showed the isolated CLAUDE_CONFIG_DIR
  #    path (permissionMode default, non-curl Bash denied) does not load the user
  #    settings.json but DID load the repo's gitignored .claude/settings.local.json,
  #    which grants `npm run *`, `git *`, `gh pr *`, `npx vercel *` and more.
  #    CAST's managed PreToolUse hook fired 80x in those transcripts.
  #  - `--strict-mcp-config`: per `claude --help` (2.1.308), only MCP servers from
  #    --mcp-config are used, and none is passed. `--tools` caps the toolset.
  #  - claude runs with cwd = DISCOVERY_WORK_DIR, an EMPTY secret-free directory
  #    outside the repo (see _prepare_work_dir), because the repo root holds
  #    .env.local (DATABASE_URL owner, API_ADMIN_TOKEN, Resend key) and Read
  #    and `curl -d @.env.local` both succeeded there with the old flags.
  # `Write`/`Edit`/`NotebookEdit`/`Agent`/`Task` stay denied. Kept as a shared
  # array (both invoke_claude branches) so the two invocations can't drift,
  # expanded via the same bash-3.2-safe idiom as CAFFEINATE_PREFIX. The
  # `Bash(...:*)` grant contains parens/glob and MUST stay a single array
  # element - never re-split this into a bare string.
  FETCH_URL_BIN="$REPO_ROOT/scripts/discovery/fetch-url.sh"
  DISCOVERY_WORK_DIR="${DISCOVERY_WORK_DIR:-$HOME/.compute-atlas-discovery/work}"
  BATCH_CONTRACT="$BATCH_CONTRACT To fetch a URL from the shell, run exactly: $FETCH_URL_BIN 'https://...' (one http or https URL, GET only); raw curl is not available; use exactly one plain URL argument."
  # The model must read the candidate contract (lib/schema.ts) to emit valid
  # facilities, but the work dir is empty and Read/Glob/Grep are confined to
  # the cwd (measured 2026-10-28: a Read of a repo path is refused; with
  # `--add-dir <dir>` it succeeds). Granting the repo or lib/ would expose more
  # than the contract, so run.sh copies ONLY schema.ts and status.ts (STATUS_ORDER) into a dedicated dir
  # (outside the repo and outside the work dir) and adds just that dir.
  # 2026-10-28: without this the model's `cat lib/schema.ts` was denied once
  # Bash was narrowed (#489) and it guessed the schema: 98 candidates rejected.
  DISCOVERY_CONTRACT_DIR="$HOME/.compute-atlas-discovery/contract"
  SCHEMA_CONTRACT_FILE="$DISCOVERY_CONTRACT_DIR/schema.ts"
  STATUS_CONTRACT_FILE="$DISCOVERY_CONTRACT_DIR/status.ts"
  CLAUDE_TOOL_FLAGS=(--restricted --strict-mcp-config --add-dir "$DISCOVERY_CONTRACT_DIR" --tools "WebSearch,WebFetch,Read,Glob,Grep,Bash" --allowedTools "WebSearch WebFetch Read Glob Grep Bash($FETCH_URL_BIN:*)" --disallowedTools "Write Edit NotebookEdit Agent Task Bash(ps:*) Bash(pgrep:*) Bash(lsof:*)")

  # Long-lived Claude Code token for this headless job. The CLI's own refreshable
  # login expired 4 times in 9 days (2026-09-26, 09-27, 10-03, 10-04), each time
  # failing the whole batch as `auth`. `claude setup-token` mints a ~1-year
  # subscription token; the maintainer keeps it in the login keychain and it is
  # read here, once per run. An absent token is not an error: fall back to the
  # CLI's stored login, as before.
  #
  # How the value travels (every hop is deliberate):
  #   - It sits in a plain (NOT exported) shell variable, so npx/tsx/notify and
  #     every other subprocess of this script never see it.
  #   - It reaches `claude` over a PIPE FILE DESCRIPTOR (fd 3, see invoke_claude),
  #     not the environment. An exec environment is readable by a sibling process
  #     (sysctl KERN_PROCARGS2), including a sandboxed Bash call that a
  #     prompt-injected session could make, and `caffeinate`/`timeout` would hold
  #     it too. A pipe is single-read and gone once claude has consumed it.
  #   - Never as an argv word (`env VAR=… cmd`), which `ps` would expose.
  #   - Never logged: the log lines below name the keychain item, not the value,
  #     and each place that expands it switches xtrace off first, so `bash -x` or
  #     an inherited SHELLOPTS=xtrace cannot print it.
  # Setup/rotation: docs/discovery-runbook.md#auth-note.
  DISCOVERY_CLAUDE_TOKEN_SERVICE="${DISCOVERY_CLAUDE_TOKEN_SERVICE:-compute-atlas-discovery-claude-token}"
  # Isolated CLI config dir used ONLY when a keychain token is present (a stored
  # login outranks the fd-3 token otherwise; see the comment in invoke_claude).
  DISCOVERY_CLAUDE_CONFIG_DIR="${DISCOVERY_CLAUDE_CONFIG_DIR:-$HOME/.compute-atlas-discovery/claude-config}"

  # Model + effort are pinned explicitly because the isolated config dir above
  # stops claude loading ~/.claude/settings.json (which carried model=opus,
  # effortLevel=high). On 2026-10-11 the run silently fell to Sonnet at default
  # effort, did 2 searches per state, returned [] for 3 states and reported ok.
  # Validated up front so a typo fails the run before any state is spent.
  DISCOVERY_CLAUDE_MODEL="${DISCOVERY_CLAUDE_MODEL:-opus}"
  DISCOVERY_CLAUDE_EFFORT="${DISCOVERY_CLAUDE_EFFORT:-high}"
  # No leading dash either: `--model -p` would swallow the next flag as the value.
  if [[ ! "$DISCOVERY_CLAUDE_MODEL" =~ ^[^-[:space:]][^[:space:]]*$ ]]; then
    log "ERROR: DISCOVERY_CLAUDE_MODEL='${DISCOVERY_CLAUDE_MODEL}' must be non-empty, with no whitespace and no leading dash - refusing to run"
    exit 1
  fi
  case "$DISCOVERY_CLAUDE_EFFORT" in
    low | medium | high | xhigh | max) ;;
    *)
      log "ERROR: DISCOVERY_CLAUDE_EFFORT='${DISCOVERY_CLAUDE_EFFORT}' is not one of low medium high xhigh max - refusing to run"
      exit 1
      ;;
  esac
  CLAUDE_TOOL_FLAGS+=(--model "$DISCOVERY_CLAUDE_MODEL" --effort "$DISCOVERY_CLAUDE_EFFORT")

  # Minimum wall-clock for an EMPTY result to be believed. A genuine "nothing
  # new" run still does many searches and takes minutes (shortest healthy run
  # observed ~5 min); on 2026-10-11 a misconfigured run returned a valid `[]` in
  # 14-20 s for 3 states and was reported ok. 0 disables the guard. Non-negative
  # integer (validate_positive_int_env cannot express 0), so a typo fails loudly.
  DISCOVERY_MIN_CLAUDE_SECS="${DISCOVERY_MIN_CLAUDE_SECS:-120}"
  if [[ ! "$DISCOVERY_MIN_CLAUDE_SECS" =~ ^[0-9]+$ ]]; then
    log "ERROR: DISCOVERY_MIN_CLAUDE_SECS='${DISCOVERY_MIN_CLAUDE_SECS}' must be a non-negative integer (0 disables) - refusing to run"
    exit 1
  fi
  log "claude model=${DISCOVERY_CLAUDE_MODEL} effort=${DISCOVERY_CLAUDE_EFFORT}"

  # `security` has no timeout of its own: a locked keychain or an unanswered ACL
  # prompt would hang the whole run unbounded, so the read is capped like the
  # claude call (TIMEOUT_BIN was resolved above; with none, it runs uncapped, as
  # claude does). Env-overridable so the BATS suite can probe it in seconds.
  DISCOVERY_KEYCHAIN_TIMEOUT_SECS="$(validate_positive_int_env DISCOVERY_KEYCHAIN_TIMEOUT_SECS 10)"
  KEYCHAIN_TIMEOUT_PREFIX=()
  if [[ -n "$TIMEOUT_BIN" ]]; then
    KEYCHAIN_TIMEOUT_PREFIX=("$TIMEOUT_BIN" -k 2 "$DISCOVERY_KEYCHAIN_TIMEOUT_SECS")
  fi

  CLAUDE_TOKEN_VALUE=""
  CLAUDE_TOKEN_PRESENT=0
  KEYCHAIN_RC=0
  _xtrace_was_on=0
  case $- in *x*) _xtrace_was_on=1 ;; esac
  { set +x; } 2>/dev/null
  if command -v security >/dev/null 2>&1; then
    CLAUDE_TOKEN_VALUE="$("${KEYCHAIN_TIMEOUT_PREFIX[@]+"${KEYCHAIN_TIMEOUT_PREFIX[@]}"}" security find-generic-password -s "$DISCOVERY_CLAUDE_TOKEN_SERVICE" -a "${USER:-$(id -un)}" -w 2>/dev/null)" || KEYCHAIN_RC=$?
  fi
  if [[ "$KEYCHAIN_RC" -ne 0 ]]; then
    CLAUDE_TOKEN_VALUE=""
  fi
  if [[ -n "$CLAUDE_TOKEN_VALUE" ]]; then
    CLAUDE_TOKEN_PRESENT=1
  fi
  if [[ "$_xtrace_was_on" -eq 1 ]]; then
    set -x
  fi

  if [[ "$CLAUDE_TOKEN_PRESENT" -eq 1 ]]; then
    log "using long-lived Claude token from keychain item $DISCOVERY_CLAUDE_TOKEN_SERVICE (isolated config dir $DISCOVERY_CLAUDE_CONFIG_DIR)"
  elif [[ "$KEYCHAIN_RC" -eq 124 || "$KEYCHAIN_RC" -eq 137 ]]; then
    log "WARN: keychain read for item $DISCOVERY_CLAUDE_TOKEN_SERVICE timed out after ${DISCOVERY_KEYCHAIN_TIMEOUT_SECS}s (locked keychain or an unanswered access prompt?) — falling back to the CLI's stored login, which expires (see docs/discovery-runbook.md#auth-note)"
  else
    log "no long-lived Claude token in keychain item $DISCOVERY_CLAUDE_TOKEN_SERVICE — falling back to the CLI's stored login, which expires (see docs/discovery-runbook.md#auth-note)"
  fi

  # The claude command itself, split out so the token-carrying and token-free
  # call sites below share ONE definition and cannot drift. It only reads
  # globals and assigns none, so the token-carrying call site can run it in a
  # subshell and lose nothing; its exit status is the claude pipeline's own
  # (timeout's 124/137 included) and must stay the last thing it returns.
  # claude runs in a subshell that cd's to WORK_DIR_PHYS (a secret-free dir, see
  # _prepare_work_dir) so run.sh's own cwd is untouched; the OUTFILE redirect is
  # applied OUTSIDE the subshell so a relative LOG_DIR still resolves against
  # REPO_ROOT. fd 3 (token branch) is inherited by the subshell.
  _run_claude() {
    if [[ -n "$TIMEOUT_BIN" ]]; then
      ( cd "$WORK_DIR_PHYS" && "${CAFFEINATE_PREFIX[@]+"${CAFFEINATE_PREFIX[@]}"}" "$TIMEOUT_BIN" -k "$DISCOVERY_KILL_AFTER_SECS" "$DISCOVERY_TIMEOUT_SECS" claude -p "$PROMPT" --append-system-prompt "$BATCH_CONTRACT" "${CLAUDE_TOOL_FLAGS[@]+"${CLAUDE_TOOL_FLAGS[@]}"}" --output-format text < /dev/null ) > "$OUTFILE"
    else
      ( cd "$WORK_DIR_PHYS" && "${CAFFEINATE_PREFIX[@]+"${CAFFEINATE_PREFIX[@]}"}" claude -p "$PROMPT" --append-system-prompt "$BATCH_CONTRACT" "${CLAUDE_TOOL_FLAGS[@]+"${CLAUDE_TOOL_FLAGS[@]}"}" --output-format text < /dev/null ) > "$OUTFILE"
    fi
  }

  # Sets LAST_INVOKE_ELAPSED (seconds of wall-clock) on every path, so the
  # caller can tell an enforced cap from one that silently did nothing —
  # exit status cannot (see the -k measurement above).
  LAST_INVOKE_ELAPSED=0
  # Set to 1 when the token-present branch could not create the isolated config
  # dir (claude was never started, so OUTFILE has no text to classify). The
  # caller maps it to class `auth`: that class already means "credential setup
  # is broken, a retry cannot fix it" and carries the no-retry, batch-latch,
  # re-queue and heartbeat handling, so no new class is needed.
  # Resolve and vet the secret-free cwd for claude. Sets WORK_DIR_PHYS; returns 1
  # (claude is never started) unless the dir (a) is not REPO_ROOT or inside it,
  # (b) does not contain REPO_ROOT (e.g. $HOME would cover .env.local), and
  # (c) is EMPTY (a regular .DS_Store is tolerated: Finder creates it). Emptiness
  # also covers .env*, dangling symlinks and an inherited noglob. Fails closed if
  # find itself errors. Order matters: create, resolve, validate, and only then
  # chmod 700 the ACCEPTED dir, so a refused pre-existing dir keeps its mode.
  # Deletes nothing.
  WORK_DIR_PHYS=""
  _prepare_work_dir() {
    local _w _r _first
    if [[ ! -d "$DISCOVERY_WORK_DIR" ]] && ! mkdir -p "$DISCOVERY_WORK_DIR" 2>/dev/null; then
      log "ERROR: discovery work dir $DISCOVERY_WORK_DIR cannot be created - refusing to start claude"
      return 1
    fi
    _w="$(cd "$DISCOVERY_WORK_DIR" 2>/dev/null && pwd -P)" || _w=""
    _r="$(cd "$REPO_ROOT" 2>/dev/null && pwd -P)" || _r=""
    if [[ -z "$_w" || -z "$_r" ]]; then
      log "ERROR: discovery work dir $DISCOVERY_WORK_DIR cannot be resolved - refusing to start claude"
      return 1
    fi
    if [[ "$_w/" == "$_r/"* ]]; then
      log "ERROR: discovery work dir $_w is the repo root or inside it ($_r) - refusing to start claude"
      return 1
    fi
    if [[ "$_r/" == "$_w/"* ]]; then
      log "ERROR: discovery work dir $_w contains the repo ($_r) - refusing to start claude"
      return 1
    fi
    if ! _first="$(find "$_w" -mindepth 1 -maxdepth 1 ! -name .DS_Store -print 2>/dev/null)"; then
      log "ERROR: discovery work dir $_w cannot be listed - refusing to start claude"
      return 1
    fi
    if [[ -n "$_first" ]]; then
      log "ERROR: discovery work dir $_w is not empty (first entry: ${_first%%$'\n'*}) - refusing to start claude"
      return 1
    fi
    if [[ -L "$_w/.DS_Store" || ( -e "$_w/.DS_Store" && ! -f "$_w/.DS_Store" ) ]]; then
      log "ERROR: discovery work dir $_w has a non-regular .DS_Store - refusing to start claude"
      return 1
    fi
    if ! chmod 700 "$_w" 2>/dev/null; then
      log "ERROR: discovery work dir $_w cannot be chmod 700 - refusing to start claude"
      return 1
    fi
    WORK_DIR_PHYS="$_w"
  }

  LAST_INVOKE_CONFIG_FAILED=0
  # Refresh the contract copy before every session (fail closed: a missing or
  # stale contract is how the 2026-10-28 run guessed the schema).
  # The path is hardcoded on purpose (no env override): it is granted to the
  # session with --add-dir and chmod'd 700, so an override such as $HOME would
  # hand over the whole home dir. Only schema.ts and status.ts are staged.
  # intake-fields.ts (URL validator) and us-states.ts (state-code lookup) are
  # deliberately NOT staged: the model never guessed those wrong, while the
  # 2026-10-28 rejections were all vocabulary (source kind enum, lat/lon).
  # Refuses (never deletes) a symlinked dir or parent, foreign ownership, a
  # path that resolves elsewhere, any non-regular entry, and any entry other
  # than the two files. Leftover .schema.XXXXXX temp files from a killed run are
  # harmless schema copies and are not auto-deleted. The physical-path check is
  # defence in depth: it is unreachable after the symlink checks above it.
  _prepare_contract_dir() {
    local _parent _phys _stray _tmp_s="" _tmp_t=""
    _parent="$HOME/.compute-atlas-discovery"
    if [[ -L "$_parent" || -L "$DISCOVERY_CONTRACT_DIR" ]]; then
      log "ERROR: contract dir $DISCOVERY_CONTRACT_DIR or its parent is a symlink - refusing to start claude"
      return 1
    fi
    if ! mkdir -p "$DISCOVERY_CONTRACT_DIR" 2>/dev/null; then
      log "ERROR: cannot create contract dir $DISCOVERY_CONTRACT_DIR - refusing to start claude"
      return 1
    fi
    if [[ -L "$DISCOVERY_CONTRACT_DIR" || ! -d "$DISCOVERY_CONTRACT_DIR" || ! -O "$DISCOVERY_CONTRACT_DIR" ]]; then
      log "ERROR: contract dir $DISCOVERY_CONTRACT_DIR is a symlink or not owned by the current user - refusing to start claude"
      return 1
    fi
    _phys="$(cd "$DISCOVERY_CONTRACT_DIR" 2>/dev/null && pwd -P)" || _phys=""
    if [[ -z "$_phys" || "$_phys" != "$(cd "$_parent" 2>/dev/null && pwd -P)/contract" ]]; then
      log "ERROR: contract dir $DISCOVERY_CONTRACT_DIR resolves to ${_phys:-nothing}, not under $_parent - refusing to start claude"
      return 1
    fi
    if ! chmod 700 "$DISCOVERY_CONTRACT_DIR" 2>/dev/null; then
      log "ERROR: contract dir $DISCOVERY_CONTRACT_DIR cannot be chmod 700 - refusing to start claude"
      return 1
    fi
    # Type check first, whatever the name: a symlink named like a temp file
    # (or schema.ts itself) would let --add-dir Read follow it to its target.
    if ! _stray="$(find "$DISCOVERY_CONTRACT_DIR" -mindepth 1 -maxdepth 1 ! -type f -print 2>/dev/null)"; then
      log "ERROR: contract dir $DISCOVERY_CONTRACT_DIR cannot be listed - refusing to start claude"
      return 1
    fi
    if [[ -n "$_stray" ]]; then
      log "ERROR: contract dir $DISCOVERY_CONTRACT_DIR has a non-regular entry (first: ${_stray%%$'\n'*}) - refusing to start claude"
      return 1
    fi
    if ! _stray="$(find "$DISCOVERY_CONTRACT_DIR" -mindepth 1 -maxdepth 1 ! -name schema.ts ! -name status.ts ! -name '.schema.*' ! -name '.status.*' -print 2>/dev/null)"; then
      log "ERROR: contract dir $DISCOVERY_CONTRACT_DIR cannot be listed - refusing to start claude"
      return 1
    fi
    if [[ -n "$_stray" ]]; then
      log "ERROR: contract dir $DISCOVERY_CONTRACT_DIR has an unexpected entry (first: ${_stray%%$'\n'*}) - refusing to start claude"
      return 1
    fi
    if ! { _tmp_s="$(mktemp "$DISCOVERY_CONTRACT_DIR/.schema.XXXXXX")" \
      && cp "$REPO_ROOT/lib/schema.ts" "$_tmp_s" \
      && [[ -s "$_tmp_s" ]] \
      && _tmp_t="$(mktemp "$DISCOVERY_CONTRACT_DIR/.status.XXXXXX")" \
      && cp "$REPO_ROOT/lib/status.ts" "$_tmp_t" \
      && [[ -s "$_tmp_t" ]] \
      && mv -f "$_tmp_s" "$SCHEMA_CONTRACT_FILE" \
      && mv -f "$_tmp_t" "$STATUS_CONTRACT_FILE"; } 2>/dev/null; then
      rm -f "$_tmp_s" "$_tmp_t" 2>/dev/null || :
      log "ERROR: cannot stage the schema contract into $DISCOVERY_CONTRACT_DIR - refusing to start claude"
      return 1
    fi
  }

  invoke_claude() {
    local _t0 _t1 _status=0 _xt=0
    LAST_INVOKE_CONFIG_FAILED=0
    if ! _prepare_contract_dir; then
      LAST_INVOKE_CONFIG_FAILED=1
      return 1
    fi
    _t0="$(date '+%s')"
    if [[ -z "$TIMEOUT_BIN" ]]; then
      log "WARN: no timeout/gtimeout binary found — running claude without a wall-clock cap"
    fi
    if [[ "$CLAUDE_TOKEN_PRESENT" -eq 1 ]]; then
      # The token is handed over fd 3 of a one-shot pipe and named to the CLI by
      # CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3. That variable exists in the
      # shipped CLI (2.1.288) but is NOT on the public env-vars docs page, so this
      # is version-pinned behaviour. MEASURED 2026-10-10 (CLI 2.1.294): a STORED
      # LOGIN (~/.claude / keychain `Claude Code-credentials`) OUTRANKS the fd-3
      # token - default config + a bogus token still got a reply. With
      # CLAUDE_CONFIG_DIR at a fresh empty dir and no token: "Not logged in";
      # same empty dir + a bogus token: 401 (the token IS honoured when no stored
      # login exists). So the token only takes effect under an isolated config
      # dir, which is set below. Consequences: the user settings.json does not
      # load on this path (2026-10-27 transcript analysis), but CAST's managed
      # PreToolUse hook DID fire (80x in discovery transcripts) and the repo's
      # gitignored .claude/settings.local.json loaded unless --restricted (see
      # CLAUDE_TOOL_FLAGS). Tool permissions come from the explicit flags.
      # Upside: the user-level CLAUDE.md/memory no longer contaminates
      # the headless discovery prompt. And an invalid token now fails the run LOUDLY (classified
      # `auth` -> the batch short-circuits, the states are re-queued, the
      # watchdog goes red) even when the interactive login is fine. See
      # docs/discovery-runbook.md#auth-note.
      #
      # CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 is defence in depth across CLI
      # versions. Per the Claude Code env-var docs it strips credentials from the
      # environment of Bash-tool subprocesses, hooks, the status line and stdio MCP
      # servers (CLI >= 2.1.180). The CLI verified here (2.1.288) already strips
      # CLAUDE_CODE_OAUTH_TOKEN from Bash-tool environments regardless, and with fd
      # delivery no environment holds the token at all — so the real exposure the
      # FD closes is the exec environment of `timeout`/`claude` themselves, not a
      # `curl …$CLAUDE_CODE_OAUTH_TOKEN`. The flag is kept because it costs nothing
      # and still covers a future CLI that stops scrubbing by default.
      #
      # Why a PIPELINE into a subshell rather than the obvious `3< <(printf …)`:
      # process substitution is a SYNTAX ERROR in bash 3.2 POSIX mode (macOS
      # /bin/sh, or an inherited POSIXLY_CORRECT), and because it sits inside the
      # enclosing `if`, it would stop run.sh from parsing at all there. A pipe has
      # the same single-read semantics in every mode. Likewise both variables are
      # exported inside the SUBSHELL, not as an env-assignment prefix on the
      # `_run_claude` function call: for a shell FUNCTION that prefix persists after
      # the call in bash 3.2 POSIX mode and would be inherited by every later child
      # (npx/submit/check-sources). The subshell takes its exports with it.
      #
      # The writer ignores SIGPIPE and cannot fail, so an early-exiting reader
      # (e.g. no `claude` binary) never turns into a spurious status under
      # pipefail: the pipeline's status is exactly the subshell's. xtrace is
      # switched off across the one place the value is expanded.
      case $- in *x*) _xt=1 ;; esac
      { set +x; } 2>/dev/null
      if ! _prepare_work_dir; then
        _status=1
        LAST_INVOKE_CONFIG_FAILED=1
      elif ! { mkdir -p "$DISCOVERY_CLAUDE_CONFIG_DIR" && chmod 700 "$DISCOVERY_CLAUDE_CONFIG_DIR"; } 2>/dev/null; then
        log "ERROR: cannot create isolated Claude config dir $DISCOVERY_CLAUDE_CONFIG_DIR - refusing to fall back to the stored login"
        _status=1
        LAST_INVOKE_CONFIG_FAILED=1
      else
        { trap '' PIPE; printf '%s' "$CLAUDE_TOKEN_VALUE" || :; } | ( export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 CLAUDE_CONFIG_DIR="$DISCOVERY_CLAUDE_CONFIG_DIR"; _run_claude 3<&0 ) || _status=$?
      fi
      if [[ "$_xt" -eq 1 ]]; then
        set -x
      fi
    elif ! _prepare_work_dir; then
      _status=1
      LAST_INVOKE_CONFIG_FAILED=1
    else
      _run_claude || _status=$?
    fi
    _t1="$(date '+%s')"
    LAST_INVOKE_ELAPSED=$(( _t1 - _t0 ))
    return "$_status"
  }

  # candidates_file_shape: ONE parse of the candidates file, mirroring
  # parseCandidatesJson's accept/reject semantics exactly (raw array, or a
  # preamble-tolerant [ .. ] slice) so a legitimately empty `[]` is never
  # mistaken for a parse failure. Prints exactly one of:
  #   empty    — parses to an array with ZERO elements (parsed, not byte-counted)
  #   nonempty — parses to an array with >= 1 element
  #   bad      — unparseable, not an array, OR the helper itself failed to spawn
  # Fail-closed: callers treat anything but empty|nonempty as "no array", so a
  # failed spawn can never read as ok.
  candidates_file_shape() {
    local _shape
    _shape="$(npx tsx -e '
import { parseCandidatesJson } from "./scripts/discovery/submit-candidates.ts";
import { readFileSync } from "node:fs";
try {
  const a = parseCandidatesJson(readFileSync(process.argv[1], "utf8"));
  console.log(Array.isArray(a) ? (a.length === 0 ? "empty" : "nonempty") : "bad");
} catch {
  console.log("bad");
}
' "$1" 2>/dev/null)" || _shape="bad"
    case "$_shape" in
      empty | nonempty) echo "$_shape" ;;
      *) echo bad ;;
    esac
  }
fi

# --- false-OK guard ----------------------------------------------------------
# submit_summary_counts <runId>: print "<discovered> <skippedInvalid>" from the
# run summary submit-candidates.ts writes to $LOG_DIR/run-<runId>.json, or
# "bad" when the file is missing/unparseable or either field is not a
# non-negative integer. Fail-closed: callers treat anything but two integers as
# "summary unreadable", never as OK.
submit_summary_counts() {
  local _out
  _out="$(node -e '
try {
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ok = (n) => Number.isSafeInteger(n) && n >= 0;
  console.log(ok(s.discovered) && ok(s.skippedInvalid) ? s.discovered + " " + s.skippedInvalid : "bad");
} catch {
  console.log("bad");
}
' "$LOG_DIR/run-$1.json" 2>/dev/null)" || _out="bad"
  case "$_out" in
    [0-9]*" "[0-9]*) echo "$_out" ;;
    *) echo bad ;;
  esac
}

# --- failure classification -------------------------------------------------
# classify_candidates_failure <file>: WHY did this run produce no parseable
# candidate array? Every such failure used to be reported as "no parseable
# candidate array", which reads as "the model emitted bad JSON" — and a census
# of discovery-logs/ showed it almost never is. Pure bash (no npx/node) so the
# diagnosis stays cheap and still works when the toolchain is itself the thing
# that broke. Prints exactly one class:
#
#   blocked   — hard environmental: the session could not run to completion
#               (machine slept mid-response, or the subscription session limit
#               was hit). A retry CANNOT help — on 2026-09-11 the NC "retry"
#               ran for 3 seconds against a limit that reset hours later.
#   auth      — hard environmental: the Claude Code login is expired or invalid
#               ("Failed to authenticate: OAuth session expired and could not
#               be refreshed"). A retry CANNOT help and neither can any later
#               state in the batch — on 2026-10-03/04 (and 09-26/27) every run
#               failed in 2-3 s with a 73-byte file and was reported as
#               no_array, sending the operator hunting a JSON bug.
#   api_error — transient API/network fault ("API Error: ..."), e.g. the
#               2026-07-25 TX and 2026-08-11 VA runs. A retry is reasonable.
#   no_array  — genuine unparseable model output: prose instead of JSON, as on
#               2026-07-15 when the AZ run ended with a session summary and a
#               journal write. Includes an empty file. This is the case the
#               bounded retry below was built for, and retry stays right for it.
#
# ⚠️ ORDER IS LOAD-BEARING. "API Error: Your computer went to sleep
# mid-response." contains BOTH markers, so the `blocked` patterns MUST be
# tested BEFORE `API Error`. Reordering these so the generic `API Error` comes
# first reads tidier and is wrong: every sleep failure would be misclassified
# as transient and earn a pointless retry into a machine that is asleep. The
# same holds for `auth`: an expired-login message can be wrapped in an
# "API Error: ..." envelope, so `auth` is also tested BEFORE `API Error`.
classify_candidates_failure() {
  local _head=""
  # Only the first 4 KB: every observed environmental failure is under 100
  # bytes, and a healthy candidates file is up to 80 KB of JSON there is no
  # reason to scan.
  _head="$(head -c 4096 "$1" 2>/dev/null || true)"
  case "$_head" in
    # blocked and auth FIRST — see the ordering note above. Do not "tidy" this.
    *"went to sleep"* | *"session limit"*) echo "blocked" ;;
    *"Failed to authenticate"* | *"OAuth session expired"* | *"Please run /login"*) echo "auth" ;;
    *"API Error"*) echo "api_error" ;;
    *) echo "no_array" ;;
  esac
}

# classify_candidates_reason <class>: the human-readable phrase for a class,
# used in the WARN log, the FAILURES entry and therefore the desktop
# notification. Kept next to the classifier so the two never drift.
classify_candidates_reason() {
  case "$1" in
    blocked) echo "run blocked by the environment (computer slept or session limit)" ;;
    auth) echo "Claude Code login expired or invalid (run \`claude auth login\`, or refresh the long-lived token)" ;;
    api_error) echo "transient API error before any candidate array" ;;
    suspect_short) echo "claude returned an empty array implausibly fast (suspected misconfigured run)" ;;
    *) echo "no parseable candidate array" ;;
  esac
}

# candidates_file_bytes <file>: size of the candidates file, or 0 if missing.
# Logged on every failure because size is the single best tell and was
# previously invisible: 66–91 bytes is an environmental error string, 3 bytes
# is a legitimate empty `[]`, and a healthy run writes 3.6 KB–80 KB.
candidates_file_bytes() {
  local _n
  _n="$(wc -c < "$1" 2>/dev/null || echo 0)"
  echo "${_n//[^0-9]/}"
}

# --- self-reverting review cap ----------------------------------------------
# Burst: BURST_CAP candidates/day for the first BURST_DAYS days after
# BURST_START_DATE (a deliberate ~2-week catch-up while the daily review queue
# is fresh), then auto-revert to STEADY_CAP/day. No manual step to revert —
# the date does it. MAX_CANDIDATES in the environment always overrides
# (escape hatch / tests).
# Caps raised 2026-08-14 (10/5 -> 25/15, ~3x) once the timeout/permission fixes
# above restored real daily yield. Steady raised again 2026-09-09 (15 -> 25):
# measured from Neon that day, the prior 14 days ran ~14-34 approved
# submissions/day against a pending queue of 0 (the maintainer clears it
# daily), with several days at 29-34 — consistent with the ceiling binding on
# some lanes.
# NOTE: the burst window expired 2026-08-19 (BURST_START_DATE + BURST_DAYS), so
# compute_cap already returns STEADY_CAP every run, confirmed still true as of
# this change (2026-09-13 is 45 days past BURST_START_DATE, past BURST_DAYS=20).
#
# STEADY_CAP raised 25 -> 30 (2026-09-13, +20%: 2 x 25 = 50/day -> 2 x 30 =
# 60/day; STATES_PER_RUN went 2 -> 3 on 2026-10-09, so the per-state discovery
# ceiling is now 3 x 30 = 90/day, and the real nightly ceiling including the
# enrichment submit is 3 x 30 + 30 = 120 — see the PER SUBMIT CALL note below),
# deliberately WITHOUT raising STATES_PER_RUN or BURST_CAP — see
# STATES_PER_RUN's comment above for why STATES_PER_RUN specifically was left
# alone. Three reasons for choosing this lever, and for the size:
#   1. The wall-clock cap is known NOT to reliably enforce (three overruns of
#      6399s/4232s/5456s against a 3000s cap, 2026-08-15, cause still
#      unknown — see the OVERRUN_LIMIT_SECS WARN below). Raising the per-state
#      cap adds no new unbounded window; raising STATES_PER_RUN would.
#   2. The previous bump (bab032f, steady 15 -> 25) is four days old as of
#      2026-09-13. Whether 25/day is sustainable isn't known yet; stacking a
#      second unmeasured throughput change on top of it would make either
#      regression unattributable.
#   3. The rotation itself just grew 22 -> 51 states (2.3x) in this same
#      change — see DEFAULT_STATES above. A large scope change and a large
#      throughput change landing together is exactly what (2) warns against.
# Re-evaluation trigger: revisit this cap after ~1 week of nights running the
# 51-state rotation at cap=30. Look at (a) wall-clock overrun WARNs, (b)
# `blocked` classifications from classify_candidates_failure, and (c) whether
# full submit cycles are completing within the invocation's time budget. This
# is "measure those three, then decide" — not "raise it again on a timer".
#
# Side effect of steady != burst: today (2026-09-13) BURST_CAP (25) is LOWER
# than STEADY_CAP (30), which the old code never had to consider because both
# were 25. compute_cap() returns STEADY_CAP unconditionally right now (burst
# window expired 2026-08-19, confirmed above), so this has NO effect today —
# but if BURST_START_DATE is ever re-dated to reactivate a burst window
# without also raising BURST_CAP, compute_cap() would return a cap BELOW the
# steady value for that window's duration: a dip, not a catch-up. Whoever
# re-dates BURST_START_DATE next must also raise BURST_CAP to at least
# STEADY_CAP, or the burst window will silently throttle below the current
# baseline instead of exceeding it.
# Applied PER SUBMIT CALL below (a ceiling per call, not a per-batch total).
# There are STATES_PER_RUN of those calls inside the per-state loop, plus ONE
# more for the enrichment lane, which runs once per batch outside the loop — so
# the real nightly ceiling is (STATES_PER_RUN x cap) + cap = 120 at the current
# defaults (3 x 30 + 30, since 2026-10-09); it was 90 at 2 states (2 x 30 + 30)
# and 75 before the 2026-09-13 cap raise (2 x 25 + 25). The leads lane does not
# use this cap; it is bounded separately by LEADS_LIMIT.
# It is a ceiling, not a target: whole-run yield measured ~14-34 approved/day
# across all states, i.e. the busiest days sit around 45% of the old ceiling.
# Headroom is real but not vast — raising STATES_PER_RUN or the cap raises what
# the maintainer may have to review in a day.
BURST_START_DATE="2026-07-30"   # date the self-reverting cap shipped
BURST_DAYS=20
BURST_CAP=25
STEADY_CAP=30

compute_cap() {
  # BSD (macOS) and GNU (Linux/CI) date differ; try BSD -j -f first, then GNU -d.
  local start_epoch now_epoch elapsed_days
  start_epoch="$(date -j -f '%Y-%m-%d' "$BURST_START_DATE" '+%s' 2>/dev/null \
    || date -d "$BURST_START_DATE" '+%s' 2>/dev/null || echo '')"
  now_epoch="$(date '+%s')"
  if [[ -z "$start_epoch" ]]; then
    # date parsing failed on this platform — fail safe to the steady cap.
    echo "$STEADY_CAP"
    return 0
  fi
  elapsed_days=$(( (now_epoch - start_epoch) / 86400 ))
  if (( elapsed_days >= 0 && elapsed_days < BURST_DAYS )); then
    echo "$BURST_CAP"
  else
    echo "$STEADY_CAP"
  fi
}

CAP="$(compute_cap)"
log "review cap for this run: --max=${MAX_CANDIDATES:-$CAP} per state (burst=${BURST_CAP}/day for ${BURST_DAYS}d from ${BURST_START_DATE}, then ${STEADY_CAP}/day) — shared across new discovery + status + enrichment"

# --- per-state loop -----------------------------------------------------
# Everything below is isolated per state: a timeout, a no-array result, or a
# failed submit for one state must not prevent the remaining states in the
# batch from running. Every command that can legitimately fail here is
# guarded with `if`/`||` (never bare) so a nonzero exit can't trip set -e and
# abort the loop early — that would defeat the entire point of processing
# multiple states per run.
RUN_IDS=()
HB_RUN_IDS=()
HB_STATES=()
HB_STATUSES=()
HB_ELAPSED=()

# Failure ledger for the alert + exit-status decision at the bottom. Populated
# per state; a non-empty ledger means this run gets a notification AND a
# nonzero exit (open item #1) rather than completing silently as before.
FAILURES=()

# Latched the first time a state's claude call fails with the `auth` class.
# An expired login is per-machine, not per-state: every later state in the
# batch would make the same doomed call, so the loop skips claude for them.
AUTH_FAILED_IN_BATCH=false

# note_overrun: the cap-did-not-enforce detector. Exit status cannot tell us
# this (a SIGTERM-ignoring process yields 124 whether it was capped at 2s or
# ran 31s — measured), so wall-clock is the only evidence.
note_overrun() {
  local label="$1" elapsed="$2"
  if (( elapsed > OVERRUN_LIMIT_SECS )); then
    log "WARN: $label ran ${elapsed}s wall-clock against a ${DISCOVERY_TIMEOUT_SECS}s cap (+${DISCOVERY_KILL_AFTER_SECS}s kill-after, +${DISCOVERY_OVERRUN_GRACE_SECS}s grace = ${OVERRUN_LIMIT_SECS}s limit) — the wall-clock cap did NOT enforce. CAUSE UNKNOWN: machine sleep was the leading hypothesis until 2026-08-15, when three overruns (6399s/4232s/5456s vs a 3000s cap) occurred with ZERO sleep events in \`pmset -g log\` for the window. \`timeout -k\` was also verified to enforce correctly against ordinary processes, bare and wrapped in \`caffeinate -i\`, under launchd's own PATH. Do not assume sleep; collect evidence."
    FAILURES+=("$label: cap did not enforce (${elapsed}s > ${OVERRUN_LIMIT_SECS}s)")
    return 0
  fi
  return 1
}

for STATE in "${BATCH_STATES[@]}"; do
  RUN_ID="$(date '+%Y%m%dT%H%M%S')-${STATE}"
  RUN_IDS+=("$RUN_ID")
  log "starting discovery run $RUN_ID for state=$STATE"

  # --- auth short-circuit ----------------------------------------------------
  # An earlier state in this batch hit a dead Claude login (class `auth`). Calling
  # claude again would fail the same way in 2-3 s, so skip it — the existing-
  # facilities fetch too, which only exists to build that prompt. Nothing is
  # submitted (CLAUDE_ARRAY_OK stays the only path to submit) and the state is
  # recorded as a failure so the run still alerts and exits nonzero. Never true
  # in dry-run: no claude call is made there, so no state can latch it.
  if [[ "$AUTH_FAILED_IN_BATCH" == "true" ]]; then
    log "WARN: skipping claude for $STATE — Claude auth failed earlier in this batch"
    FAILURES+=("$STATE: skipped — Claude auth failed earlier in this batch")
    HB_RUN_IDS+=("$RUN_ID")
    HB_STATES+=("$STATE")
    HB_STATUSES+=("skipped")
    HB_ELAPSED+=(0)
    log "discovery run $RUN_ID complete"
    continue
  fi

  # --- existing-facilities projection (fail-open: empty string on any error) --
  if [[ "${DISCOVERY_DRY_RUN:-false}" == "true" ]]; then
    EXISTING_FACILITIES=""
  else
    if ! EXISTING_FACILITIES="$(npx tsx --env-file=.env.local scripts/discovery/existing-facilities.ts --state="$STATE" 2>>"$LOG_DIR/existing-facilities.err")"; then
      log "WARN: existing-facilities fetch failed for $STATE — proceeding with empty projection (see existing-facilities.err)"
      EXISTING_FACILITIES=""
    fi
  fi

  # --- discovery step (agentic, subscription — NEVER run during dev) ---------
  OUTFILE="$LOG_DIR/candidates-${RUN_ID}.json"

  CLAUDE_ARRAY_OK=false
  # Initialised here (not only in the live branch) so `set -u` cannot trip on
  # it in the dry-run path, which skips invoke_claude entirely.
  STATE_ELAPSED=0
  # Failure diagnosis for this state, overwritten the moment a failure is seen.
  CLAUDE_FAIL_CLASS="no_array"
  CLAUDE_FAIL_BYTES=0
  SUSPECT_SHORT=false
  INVALID_MAJORITY=false
  CANDIDATES_SHAPE=bad

  if [[ "${DISCOVERY_DRY_RUN:-false}" == "true" ]]; then
    log "DISCOVERY_DRY_RUN=true — skipping claude call, using empty candidate set"
    if [[ ! -f "$OUTFILE" ]]; then
      echo "[]" > "$OUTFILE"
    fi
    CLAUDE_ARRAY_OK=true
  else
    log "invoking claude for state=$STATE (requires an authenticated subscription session)"
    # {{EXISTING_FACILITIES}} may contain unescaped facility name/operator/URL
    # field content (slashes, ampersands, newlines, even shell metacharacters).
    # It MUST be inserted as a literal block that is never shell-evaluated or
    # re-interpreted — a plain sed s/{{X}}/$VAR/ substitution is unsafe here.
    # Use sed's `r` (read-file) command instead: replace the placeholder LINE
    # with the verbatim contents of a temp file.
    EXISTING_FACILITIES_FILE="$(mktemp)"
    printf '%s' "$EXISTING_FACILITIES" > "$EXISTING_FACILITIES_FILE"
    PROMPT="$(sed "s/{{STATE}}/$STATE/g" "$REPO_ROOT/scripts/discovery/discovery-prompt.txt" \
      | sed "/{{EXISTING_FACILITIES}}/{
r $EXISTING_FACILITIES_FILE
d
}")"
    rm -f "$EXISTING_FACILITIES_FILE"
    PROMPT="${PROMPT//\{\{SCHEMA_FILE\}\}/$SCHEMA_CONTRACT_FILE}"
    PROMPT="${PROMPT//\{\{STATUS_FILE\}\}/$STATUS_CONTRACT_FILE}"

    # Guarded: a nonzero exit here (e.g. "You've hit your session limit") must
    # not trip set -e and kill the whole batch — the submit step below is
    # gated on CLAUDE_ARRAY_OK instead of relying on invoke_claude having
    # succeeded. Exit status 124 (GNU timeout's own timeout code) is called
    # out separately so a future wall-clock-cap regression is diagnosable
    # from launchd.out alone, without needing a live repro like the
    # 2026-08-09 incident required. 137 (128+SIGKILL) is the -k escalation
    # firing — i.e. the cap working as intended against a process that ignored
    # SIGTERM — and is logged distinctly from a plain 124.
    INVOKE_STATUS=0
    invoke_claude || INVOKE_STATUS=$?
    STATE_ELAPSED="$LAST_INVOKE_ELAPSED"
    if [[ "$INVOKE_STATUS" -eq 124 ]]; then
      log "WARN: claude invocation for $RUN_ID timed out after DISCOVERY_TIMEOUT_SECS=${DISCOVERY_TIMEOUT_SECS}s (${STATE_ELAPSED}s wall-clock) — output may be empty or an error string; submit may be skipped"
    elif [[ "$INVOKE_STATUS" -eq 137 ]]; then
      log "WARN: claude invocation for $RUN_ID ignored SIGTERM and was SIGKILLed by --kill-after=${DISCOVERY_KILL_AFTER_SECS}s (${STATE_ELAPSED}s wall-clock) — the cap enforced correctly"
    elif [[ "$INVOKE_STATUS" -ne 0 && "$LAST_INVOKE_CONFIG_FAILED" -ne 1 ]]; then
      log "WARN: claude invocation for $RUN_ID exited nonzero (session limit / timeout / crash, ${STATE_ELAPSED}s wall-clock) — output may be empty or an error string; submit may be skipped"
    fi
    note_overrun "claude invocation for $RUN_ID" "$STATE_ELAPSED" || true
    CANDIDATES_SHAPE="$(candidates_file_shape "$OUTFILE")"
    CLAUDE_ARRAY_OK=false
    [[ "$CANDIDATES_SHAPE" == "empty" || "$CANDIDATES_SHAPE" == "nonempty" ]] && CLAUDE_ARRAY_OK=true

    # Bounded single retry: on 2026-07-15 the AZ run inherited the maintainer's
    # ~/.claude persona and ended its turn with a prose summary + journal write
    # instead of the JSON array — no array at all, not just malformed JSON. The
    # BATCH_CONTRACT above mitigates this but does not eliminate it, so retry
    # exactly once on a genuine no-array result, then proceed either way — the
    # submit step below skips (rather than crashes) on a still-empty/unparseable
    # OUTFILE, tracked via CLAUDE_ARRAY_OK.
    if [[ "$CLAUDE_ARRAY_OK" != "true" ]]; then
      CLAUDE_FAIL_CLASS="$(classify_candidates_failure "$OUTFILE")"
      CLAUDE_FAIL_BYTES="$(candidates_file_bytes "$OUTFILE")"
      # claude never ran (isolated config dir uncreatable): no output to classify.
      [[ "$LAST_INVOKE_CONFIG_FAILED" -eq 1 ]] && CLAUDE_FAIL_CLASS="auth"
    fi
    # A `blocked` class is a hard environmental stop (machine asleep, session
    # limit): the retry below cannot clear it and would only burn a second
    # invocation against the same wall, so it is suppressed and the run carries
    # the real cause forward instead. `auth` (dead login) is the same: a retry
    # cannot revive an expired session. `api_error` and `no_array` both still
    # retry — that is the pre-existing behaviour and it is right for them.
    if [[ "$CLAUDE_ARRAY_OK" != "true" && "$CLAUDE_FAIL_CLASS" == "blocked" ]]; then
      log "WARN: claude output for $RUN_ID was cut short by a hard environmental block (computer slept mid-response, or the subscription session limit was hit) — ${CLAUDE_FAIL_BYTES} bytes written; NOT retrying, a retry cannot clear it (2026-09-11: the NC retry ran 3s against a limit that reset hours later)"
    elif [[ "$CLAUDE_ARRAY_OK" != "true" && "$CLAUDE_FAIL_CLASS" == "auth" ]]; then
      log "WARN: claude output for $RUN_ID was a login failure (Claude Code auth expired or invalid) — ${CLAUDE_FAIL_BYTES} bytes written; NOT retrying, a retry cannot revive a dead login (2026-10-03/04: every retry ran 2s against the same expired session)"
    elif [[ "$CLAUDE_ARRAY_OK" != "true" ]]; then
      log "WARN: claude output for $RUN_ID had no parseable JSON array (cause=${CLAUDE_FAIL_CLASS}, ${CLAUDE_FAIL_BYTES} bytes) — retrying once"
      RETRY_STATUS=0
      invoke_claude || RETRY_STATUS=$?
      # Both attempts count toward this state's wall-clock: an overrun on
      # either one is the same "cap did not enforce" signal.
      STATE_ELAPSED=$(( STATE_ELAPSED + LAST_INVOKE_ELAPSED ))
      if [[ "$RETRY_STATUS" -eq 124 ]]; then
        log "WARN: retry claude invocation for $RUN_ID timed out after DISCOVERY_TIMEOUT_SECS=${DISCOVERY_TIMEOUT_SECS}s (${LAST_INVOKE_ELAPSED}s wall-clock)"
      elif [[ "$RETRY_STATUS" -eq 137 ]]; then
        log "WARN: retry claude invocation for $RUN_ID ignored SIGTERM and was SIGKILLed by --kill-after=${DISCOVERY_KILL_AFTER_SECS}s (${LAST_INVOKE_ELAPSED}s wall-clock)"
      elif [[ "$RETRY_STATUS" -ne 0 ]]; then
        log "WARN: retry claude invocation for $RUN_ID exited nonzero (${LAST_INVOKE_ELAPSED}s wall-clock)"
      fi
      note_overrun "retry claude invocation for $RUN_ID" "$LAST_INVOKE_ELAPSED" || true
      CANDIDATES_SHAPE="$(candidates_file_shape "$OUTFILE")"
      CLAUDE_ARRAY_OK=false
      [[ "$CANDIDATES_SHAPE" == "empty" || "$CANDIDATES_SHAPE" == "nonempty" ]] && CLAUDE_ARRAY_OK=true
      if [[ "$CLAUDE_ARRAY_OK" != "true" ]]; then
        CLAUDE_FAIL_CLASS="$(classify_candidates_failure "$OUTFILE")"
        CLAUDE_FAIL_BYTES="$(candidates_file_bytes "$OUTFILE")"
        # The retry's mkdir can fail even if the first call's succeeded.
        [[ "$LAST_INVOKE_CONFIG_FAILED" -eq 1 ]] && CLAUDE_FAIL_CLASS="auth"
        log "WARN: retry for $RUN_ID still produced no parseable candidate array (cause=${CLAUDE_FAIL_CLASS}, ${CLAUDE_FAIL_BYTES} bytes) — skipping submit"
      fi
    fi

    # suspect_short: a parseable but EMPTY array that came back faster than any
    # real research could (see DISCOVERY_MIN_CLAUDE_SECS). Checked after the
    # retry block and deliberately NOT retried: a retry under the same config
    # reproduces it and burns session budget. The elapsed test runs first so the
    # shape comes from the single parse above (no second spawn to fail open).
    if [[ "$CLAUDE_ARRAY_OK" == "true" ]] \
      && (( STATE_ELAPSED < DISCOVERY_MIN_CLAUDE_SECS )) \
      && [[ "$CANDIDATES_SHAPE" == "empty" ]]; then
      SUSPECT_SHORT=true
      CLAUDE_FAIL_CLASS="suspect_short"
      log "WARN: claude returned an empty array for $RUN_ID in ${STATE_ELAPSED}s (< DISCOVERY_MIN_CLAUDE_SECS=${DISCOVERY_MIN_CLAUDE_SECS}s) — a real run takes minutes; likely causes: wrong model/effort, tools unavailable. NOT retrying (same config reproduces it)"
      FAILURES+=("$STATE: claude returned an empty array in ${STATE_ELAPSED}s (< ${DISCOVERY_MIN_CLAUDE_SECS}s) — suspected misconfigured run")
    fi
  fi

  # --- submit step (deterministic — staging queue only) ---------------------
  # `if !` (never bare) so a nonzero submit exit for THIS state cannot trip
  # set -e and abort the remaining states in the batch.
  if [[ "$SUSPECT_SHORT" == "true" ]]; then
    log "skipping submit for $RUN_ID (suspect_short empty array — nothing to stage)"
  elif [[ "$CLAUDE_ARRAY_OK" == "true" ]]; then
    log "submitting candidates from $OUTFILE"
    if ! DISCOVERY_LOG_DIR="$LOG_DIR" npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts "$OUTFILE" \
      --run-id="$RUN_ID" \
      --max="${MAX_CANDIDATES:-$CAP}" \
      --state="$STATE" \
      ${API_BASE_URL:+--base-url="$API_BASE_URL"}; then
      log "WARN: submit-candidates failed for $RUN_ID (state=$STATE) — continuing with remaining states"
      FAILURES+=("$STATE: submit failed")
    elif [[ "${DISCOVERY_DRY_RUN:-false}" != "true" ]]; then
      # false-OK guard: a state whose candidates mostly fail schema validation
      # means the session could not read the schema/contract (2026-10-28: 93 of
      # 98 skippedInvalid, run still printed OK). Degrade only — no rewind.
      # Integer math: ratio > 0.5 is 2*invalid > discovered, floor of 5.
      # Dry-run is exempt, like the suspect_short guard.
      SUB_DISCOVERED="" SUB_INVALID=""
      read -r SUB_DISCOVERED SUB_INVALID <<<"$(submit_summary_counts "$RUN_ID")" || true
      if [[ -z "$SUB_INVALID" ]]; then
        log "WARN: submit summary unreadable for $RUN_ID (state=$STATE) — cannot rule out a broken schema read"
        FAILURES+=("$STATE: submit summary unreadable — cannot verify candidate validity")
      elif (( SUB_DISCOVERED >= 5 && 2 * SUB_INVALID > SUB_DISCOVERED )); then
        log "WARN: $STATE: ${SUB_INVALID}/${SUB_DISCOVERED} candidates rejected as invalid — check the session's schema/contract read first, then the facility index"
        FAILURES+=("$STATE: ${SUB_INVALID}/${SUB_DISCOVERED} candidates rejected as invalid — check the session's schema/contract read first, then the facility index")
        INVALID_MAJORITY=true
      fi
    fi
  else
    CLAUDE_FAIL_REASON="$(classify_candidates_reason "$CLAUDE_FAIL_CLASS")"
    log "WARN: ${CLAUDE_FAIL_REASON} for $RUN_ID (cause=${CLAUDE_FAIL_CLASS}, ${CLAUDE_FAIL_BYTES} bytes) — skipping submit (nothing to stage)"
    # Dry-run never reaches here (it forces CLAUDE_ARRAY_OK=true), so this is
    # always a real failure — exactly the state that went unnoticed for six
    # days. The class names the cause so the alert is actionable: a `blocked`
    # run needs the machine awake or the session limit reset, not a code fix.
    FAILURES+=("$STATE: $CLAUDE_FAIL_REASON")
    # Latch the batch-wide short-circuit at the top of the loop. Checked on the
    # FINAL class (after any retry), so a no_array whose retry surfaced the auth
    # failure also trips it.
    [[ "$CLAUDE_FAIL_CLASS" == "auth" ]] && AUTH_FAILED_IN_BATCH=true
  fi

  if [[ "${DISCOVERY_DRY_RUN:-false}" != "true" ]]; then
    # Carries the real class (blocked | auth | api_error | no_array | suspect_short), not a
    # blanket "no_array". (A state skipped by the auth short-circuit records
    # `skipped` at the top of the loop and never reaches here.) Safe for the
    # watchdog: check-heartbeat.ts reads only the top-level `status` field,
    # never `claudeStatus`.
    HEARTBEAT_STATUS="$CLAUDE_FAIL_CLASS"
    [[ "$CLAUDE_ARRAY_OK" == "true" && "$SUSPECT_SHORT" != "true" ]] && HEARTBEAT_STATUS="ok"
    [[ "$INVALID_MAJORITY" == "true" ]] && HEARTBEAT_STATUS="invalid_majority"
    HB_RUN_IDS+=("$RUN_ID")
    HB_STATES+=("$STATE")
    HB_STATUSES+=("$HEARTBEAT_STATUS")
    HB_ELAPSED+=("$STATE_ELAPSED")
  fi

  log "discovery run $RUN_ID complete"
done

# --- re-queue states an environmental failure consumed ----------------------
# The cursor advance above is written ONCE, before any research (crash-safety —
# keep that), so a state whose claude call never ran to completion is still
# consumed from the rotation. On 2026-10-03/04 an expired OAuth session did
# exactly that: ID KS KY ME were all "visited" with nothing researched, and
# would not have come round again for ~26 days (51 states / 2 per run).
#
# So after the loop, if any state's FINAL status is a hard environmental
# failure — `auth`, `skipped` (not attempted because auth died earlier in the
# batch), `blocked` (machine slept / session limit) or `suspect_short` (an empty
# array returned faster than DISCOVERY_MIN_CLAUDE_SECS: the run never really
# researched the state, so a misconfigured model/effort or missing tools is the
# likely cause — environmental, not a finding of "nothing new") — nothing was researched
# for it and a retry next batch is the right response, so rewind the cursor to
# the FIRST such state in batch order. `api_error` / `no_array` do NOT rewind:
# after the bounded retry they are not proven environmental (the model really
# can emit prose), and re-queueing them would let one bad state stall the
# rotation on a non-environmental fault.
#
# Known cost, accepted: if state A failed environmentally and a LATER state B in
# the batch succeeded, rewinding to A re-runs B next batch too. Harmless —
# submissions dedupe — and cheaper than tracking a per-state retry list. A state
# that succeeded and PRECEDES the first failure is never the target.
#
# Consequence worth stating plainly: a permanently broken login now stalls the
# rotation on the same states instead of silently skipping the whole country.
# That is correct — the watchdog fails daily on the degraded heartbeat, so the
# stall is loud, whereas the old behaviour hid a dead pipeline behind a
# "rotating" cursor.
#
# `suspect_short` is bounded to ONE consecutive rewind per state (see below).
#
# Guards: never on dry-run (no claude call was made, nothing to re-queue), and
# only on the DEFAULT rotation — a DISCOVERY_STATES override run must not write
# an override-list state into the live cursor.txt (the known trap).
if [[ "${DISCOVERY_DRY_RUN:-false}" != "true" && "$ROTATION_IS_DEFAULT" == "true" ]]; then
  # suspect_short is bounded: a state that deterministically returns a fast `[]`
  # would otherwise pin the cursor forever. It rewinds at most ONCE in a row —
  # $SUSPECT_REQUEUE_FILE holds the state last re-queued for suspect_short, and a
  # suspect_short status for that SAME state no longer counts. The failure is
  # still in FAILURES/heartbeat, so the watchdog stays red; only the rotation
  # moves on. Any batch that does not rewind for suspect_short clears the file.
  SUSPECT_REQUEUE_FILE="$LOG_DIR/suspect-short-requeued.txt"
  SUSPECT_PREV=""
  [[ -f "$SUSPECT_REQUEUE_FILE" ]] && SUSPECT_PREV="$(tr -d ' \n' <"$SUSPECT_REQUEUE_FILE" 2>/dev/null || true)"
  REWIND_INDEX=-1
  for (( _r = 0; _r < ${#HB_STATES[@]}; _r++ )); do
    case "${HB_STATUSES[$_r]}" in
      auth | skipped | blocked)
        REWIND_INDEX="$_r"
        break
        ;;
      suspect_short)
        if [[ "${HB_STATES[$_r]}" == "$SUSPECT_PREV" ]]; then
          log "WARN: ${HB_STATES[$_r]} is suspect_short twice in a row — NOT re-queuing again; the rotation is moving on (failure still recorded, watchdog stays red)"
        else
          REWIND_INDEX="$_r"
          break
        fi
        ;;
    esac
  done
  if (( REWIND_INDEX >= 0 )); then
    REWIND_STATE="${HB_STATES[$REWIND_INDEX]}"
    log "re-queued: cursor rewound ${STATES[$NEXT_INDEX]} -> ${REWIND_STATE} (environmental failure: ${HB_STATUSES[$REWIND_INDEX]}); ${HB_STATES[*]:$REWIND_INDEX} run again next batch"
    echo "$REWIND_STATE" > "$CURSOR_FILE"
    if [[ "${HB_STATUSES[$REWIND_INDEX]}" == "suspect_short" ]]; then
      echo "$REWIND_STATE" > "$SUSPECT_REQUEUE_FILE"
    else
      rm -f "$SUSPECT_REQUEUE_FILE"
    fi
  else
    rm -f "$SUSPECT_REQUEUE_FILE"
  fi
fi

# --- source-liveness check (read-only — runs ONCE per batch, after all
# states, including dry-run). Global, not per-state, and takes well over 7
# minutes cold (lookups are rate-capped; see docs/discovery-runbook.md) —
# running it once per state would be pure waste. A non-zero exit (including a
# resolver-outage abort, which writes no report) is recorded in FAILURES so the
# heartbeat and watchdog see it; later lanes still run. -------------------------
log "checking source liveness"
if ! npx tsx --env-file=.env.local scripts/discovery/check-sources.ts 2>>"$LOG_DIR/check-sources.err"; then
  log "WARN: source-liveness check failed — continuing (see check-sources.err)"
  FAILURES+=("liveness: check-sources failed")
fi

# --- field-extraction + field-verification lane (step 3) ----------
# Global, not per-state — same rationale as source-liveness above. Skipped
# entirely on a dry run because, unlike check-sources, this lane writes a
# candidates file and stages rows to the submissions queue; a dry run should
# stay fast and side-effect-free.
if [[ "${DISCOVERY_DRY_RUN:-false}" == "true" ]]; then
  log "DISCOVERY_DRY_RUN=true — skipping field-extraction/verification lane"
else
  # Bounded, not swept-to-completion: the two fields below total 2,190 gap
  # values (measured 2026-09-01 evening via selectGaps() against
  # data/facilities.json: capacityMw.operational 1,074 + water.coolingType
  # 1,116), and each takes ~6-7s per source check with ~3 checks per value —
  # an unbounded run is roughly 10 hours (proportional rescale of the
  # previously measured 12h/2,525-gap figure to the current 2,190-gap total;
  # the gap COUNT above is freshly measured, the 10h DURATION is still a
  # rescale, not a fresh timing measurement). That figure is for the two-field
  # list; since 2026-10-29 the extract list is one field, so the real horizon
  # is smaller (not re-measured). Env-overridable so an operator
  # can widen the sweep by hand without editing this script.
  #
  # ⚠️ Dropping energy.source/energy.utility (F7, 2026-09-01 — see below) does
  # NOT shorten a nightly run. selectGaps() iterates facilities outer ×
  # fields inner, and ENRICHMENT_LIMIT bounds the TOTAL number of gaps filled
  # per run, not a per-field count — so removing a field just shifts the mix
  # within the same fixed budget: more facilities get covered per night for
  # the two remaining fields, but wall-clock time per run is unchanged. What
  # DOES shrink is the full-sweep horizon above (17h → 10h), since there are
  # fewer total gaps to clear. The same logic runs in reverse for adding a
  # field back: it would not lengthen a single run, only re-widen the horizon.
  ENRICHMENT_LIMIT="$(validate_positive_int_env ENRICHMENT_LIMIT 60)"
  VERIFY_LIMIT="$(validate_positive_int_env VERIFY_LIMIT 40)"
  ENRICHMENT_RUN_ID="$(date '+%Y%m%dT%H%M%S')-enrichment"

  # ⛔⛔ CRITICAL for extract-fields: --fields MUST be passed explicitly.
  # parseFieldsArg() — shared with the read-only verify-fields lane — returns
  # the FULL six-field default set when --fields is omitted, and two of those
  # six failed the project's accuracy bench (capacityMw.planned 75% precision,
  # energy.onSiteGenerationMw 50%) — not safe to STAGE unattended. Since
  # 2026-09-11 (#276) extract-fields.ts layers a stricter rule on top of that
  # shared default and THROWS on a bare invocation, so the unsafe sweep can no
  # longer happen silently; the default itself is unchanged and stays correct
  # for verify-fields, which stages nothing. Passing --fields here is now
  # belt-and-braces rather than the only guard — do not remove it from the
  # extract-fields call to "simplify" it.
  #
  # ⚠️ Since 2026-10-29 the EXTRACT (staging) side pins only water.coolingType
  # (P=95%/R=95%, measured 2026-09-01 over 69 pages). capacityMw.operational
  # was unpinned that day (Ed): its old P=100%/R=100% measured a bench prompt
  # that had drifted from the shipped one, on a corpus with no distractor
  # pages. The 2026-10-29 distractor re-bench (scripts/discovery/bench/README.md,
  # "capacityOperational after the IT-capacity-only rule") found the old prompt
  # fabricating on 3 of 6 distractor pages and the new IT-capacity rule still
  # taking a UPS figure (1 of 6); on 2026-10-28 the lane staged "available
  # utility power" as IT capacity. Re-pin only after a re-bench under the
  # crypto/UPS rulings holds up, with Ed's OK. The field stays in
  # EXTRACTABLE_FIELDS for deliberate manual runs. Earlier, until 2026-09-01:
  # energy.source (enum)
  # and energy.utility (free text) were pinned here too, unmeasured, for
  # months — no label in truth.json, no row in any result file — and were
  # dropped from this nightly list for exactly that reason (F7: "either bench
  # them or stop shipping them", resolved as "stop shipping"). They remain in
  # EXTRACTABLE_FIELDS for deliberate manual invocation; do not re-add them
  # here without bench numbers to back it. See docs/discovery-runbook.md's
  # per-field table.
  #
  # ⚠️ water.coolingType's 95% belongs to the PROMPT, not the field. With a
  # bare vocabulary list and no decision rule, the same model on the same 69
  # pages scored P=53%/R=42%. extract-fields.ts's
  # FIELD_DESCRIPTIONS["water.coolingType"] carries
  # docs/methodology.md#cooling-type's definitions and tie-breaker verbatim
  # (byte-identical to scripts/discovery/bench/run.mjs); a drift test guards
  # it. `hybrid` is in the prompt vocabulary but REFUSED at validation because
  # it has zero positive bench labels.
  #
  # verify-fields takes a WIDER list on purpose — it is read-only and stages
  # nothing, so the ship-safety caveat above does not apply to it
  # (docs/discovery-runbook.md says so explicitly, which is why the `npm run
  # verify-fields` wrapper deliberately bakes in no field list). It keeps
  # re-checking the capacityMw.operational values already recorded even though
  # the fill lane no longer stages new ones. The list is a scope/time bound,
  # not a safety one: widening it for verify-fields is a cost question.
  EXTRACT_FIELDS="water.coolingType"
  VERIFY_FIELDS="capacityMw.operational,water.coolingType"

  if ! command -v pdftotext >/dev/null 2>&1; then
    log "WARN: pdftotext not on PATH (poppler not installed) — every PDF source in this lane will go unread; continuing degraded"
  fi

  ENRICHMENT_OUTFILE="$LOG_DIR/enrichment-${ENRICHMENT_RUN_ID}.json"
  log "extracting fields (limit=${ENRICHMENT_LIMIT} fields=${EXTRACT_FIELDS})"
  EXTRACT_OK=true
  if ! npx tsx --env-file=.env.local scripts/discovery/extract-fields.ts \
    --out "$ENRICHMENT_OUTFILE" \
    --limit="$ENRICHMENT_LIMIT" \
    --fields="$EXTRACT_FIELDS" \
    --run-id="$ENRICHMENT_RUN_ID" \
    2>>"$LOG_DIR/extract-fields.err"; then
    log "WARN: extract-fields failed for $ENRICHMENT_RUN_ID — skipping submit (see extract-fields.err)"
    FAILURES+=("enrichment: extract-fields failed")
    EXTRACT_OK=false
  fi

  if [[ "$EXTRACT_OK" == "true" ]] && [[ -s "$ENRICHMENT_OUTFILE" ]]; then
    log "submitting enrichment candidates from $ENRICHMENT_OUTFILE"
    if ! npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts "$ENRICHMENT_OUTFILE" \
      --run-id="$ENRICHMENT_RUN_ID" \
      --max="${MAX_CANDIDATES:-$CAP}" \
      ${API_BASE_URL:+--base-url="$API_BASE_URL"}; then
      log "WARN: submit-candidates failed for $ENRICHMENT_RUN_ID — continuing"
      FAILURES+=("enrichment: submit failed")
    fi
  else
    log "WARN: no enrichment candidates written for $ENRICHMENT_RUN_ID — skipping submit (nothing to stage)"
  fi

  # verify-fields is read-only (never writes dataset data). Crash durability
  # for its --out file is handled by its own per-facility checkpoint, not by
  # this redirect; stdout is still sent to a log file here so a long run's
  # progress output doesn't scroll off the terminal/launchd log buffer.
  VERIFY_OUTFILE="$LOG_DIR/verify-fields-${ENRICHMENT_RUN_ID}.json"
  log "verifying fields (limit=${VERIFY_LIMIT} fields=${VERIFY_FIELDS})"
  if ! npx tsx --env-file=.env.local scripts/discovery/verify-fields.ts \
    --limit="$VERIFY_LIMIT" \
    --fields="$VERIFY_FIELDS" \
    --out "$VERIFY_OUTFILE" \
    --run-id="$ENRICHMENT_RUN_ID" \
    >"$LOG_DIR/verify-fields-${ENRICHMENT_RUN_ID}.log" 2>>"$LOG_DIR/verify-fields.err"; then
    log "WARN: verify-fields failed for $ENRICHMENT_RUN_ID — continuing (see verify-fields.err)"
    FAILURES+=("enrichment: verify-fields failed")
  fi

  # --- community-leads lane ---------------------------------------------------
  # Works the public URL tips (`new` leads): fetch -> local Ollama extraction ->
  # verify -> duplicate guard -> geocode -> stage a PENDING submission. It never
  # writes a live facility; every row still needs a human approve. Leads it
  # cannot use go to `deferred` for review at /admin/leads. Bounded because each
  # lead costs >=2 Ollama calls plus up to 2 fetches; 10/night is ample at the
  # current tip volume (~1/day). Inside the dry-run guard because it mutates
  # lead status and stages submissions. A failure is recorded but never aborts
  # the rest of the run. Summary JSON goes to stdout, so it is captured to file.
  LEADS_LIMIT="$(validate_positive_int_env LEADS_LIMIT 10)"
  LEADS_RUN_ID="$(date '+%Y%m%dT%H%M%S')-leads"
  log "working community leads (limit=${LEADS_LIMIT})"
  if ! npx tsx --env-file=.env.local scripts/discovery/leads-lane.ts \
    --limit="$LEADS_LIMIT" \
    --run-id="$LEADS_RUN_ID" \
    >"$LOG_DIR/leads-lane-${LEADS_RUN_ID}.json" 2>>"$LOG_DIR/leads-lane.err"; then
    log "WARN: leads lane failed for $LEADS_RUN_ID — continuing (see leads-lane.err)"
    FAILURES+=("leads: lane failed")
  fi
fi

# --- PII retention prune (global, after all discovery/enrichment writes) ---
# Deletes or redacts rows that have aged out of the documented PII retention
# windows. scripts/retention-prune.ts is the single source of truth for those
# windows — do not duplicate the numbers here. The script is back-up-or-abort
# PER TABLE: every mutation is preceded by a JSON-lines backup written under
# discovery-logs/retention-backups/, and a table whose backup write fails has
# its mutation skipped rather than risked. Skipped entirely on a dry run,
# same rationale as the enrichment lane above — this lane WRITES.
if [[ "${DISCOVERY_DRY_RUN:-false}" == "true" ]]; then
  log "DISCOVERY_DRY_RUN=true — skipping retention-prune lane"
else
  log "pruning expired PII per retention policy"
  if ! npx tsx --env-file=.env.local scripts/retention-prune.ts --apply \
    >"$LOG_DIR/retention-prune-$(date '+%Y%m%dT%H%M%S').log" 2>>"$LOG_DIR/retention-prune.err"; then
    log "WARN: retention prune failed — continuing (see retention-prune.err)"
    FAILURES+=("retention: prune failed")
  fi
fi

log "discovery batch complete: states=${BATCH_STATES[*]} run_ids=${RUN_IDS[*]}"

# Heartbeat: a visible "last real run" marker so a silent launchd skip/crash is
# obvious at a glance (stale lastRunAt = job not running; claudeStatus=no_array
# = the run reached claude but got a session-limit/prose reply, not candidates;
# claudeStatus=auth = the Claude login is dead; skipped = not attempted because
# an earlier state in the batch hit auth).
# Extended to represent the whole batch (one entry per state) so a partial
# batch — some states ok, some no_array — is visibly distinguishable from a
# clean one, while staying valid JSON.
if [[ "${DISCOVERY_DRY_RUN:-false}" != "true" ]]; then
  HEARTBEAT_ENTRIES=""
  for (( _h = 0; _h < ${#HB_STATES[@]}; _h++ )); do
    _entry="    {
      \"runId\": \"${HB_RUN_IDS[$_h]}\",
      \"state\": \"${HB_STATES[$_h]}\",
      \"claudeStatus\": \"${HB_STATUSES[$_h]}\",
      \"elapsedSecs\": ${HB_ELAPSED[$_h]}
    }"
    if [[ -z "$HEARTBEAT_ENTRIES" ]]; then
      HEARTBEAT_ENTRIES="$_entry"
    else
      HEARTBEAT_ENTRIES="$HEARTBEAT_ENTRIES,
$_entry"
    fi
  done
  _hb_status="ok"
  if (( ${#FAILURES[@]} > 0 )); then
    _hb_status="degraded"
  fi
  cat >"$LOG_DIR/heartbeat.json" <<EOF
{
  "lastRunAt": "$(date '+%Y-%m-%dT%H:%M:%S%z')",
  "status": "$_hb_status",
  "failureCount": ${#FAILURES[@]},
  "states": [
$HEARTBEAT_ENTRIES
  ]
}
EOF
  log "wrote heartbeat -> $LOG_DIR/heartbeat.json (status=$_hb_status states=${HB_STATES[*]} statuses=${HB_STATUSES[*]})"

  # Publish the just-written heartbeat to Neon: discovery-logs/ is gitignored
  # and never leaves this Mac, so the off-machine GitHub Actions watchdog
  # (.github/workflows/discovery-watchdog.yml) has no way to read
  # heartbeat.json directly — Neon is the one store both this machine and CI
  # can reach. The discovery work above is already done by this point, so a
  # publish failure must not abort the run and lose it — but per this file's
  # own "a silent instrument is not monitoring" rule (see the block below),
  # it must not fail silently either: log it and record a FAILURES entry so
  # the run still exits nonzero and a local notification is still attempted
  # (attempted and logged — not guaranteed to reach a person; see notify()).
  # Note the irony this guards: a failed publish is precisely the case where
  # the off-machine watchdog CANNOT see the degradation, so the local log line
  # and the nonzero exit are all that is left.
  if ! npx tsx --env-file=.env.local scripts/discovery/publish-heartbeat.ts \
    >"$LOG_DIR/publish-heartbeat.log" 2>>"$LOG_DIR/publish-heartbeat.err"; then
    log "WARN: publish-heartbeat failed — continuing (see publish-heartbeat.err)"
    FAILURES+=("heartbeat: publish failed")
  fi
fi

# --- alert + exit status -----------------------------------------------------
# Deliberately the LAST thing in the script: everything above (submit, source
# liveness, heartbeat) must complete before a failure can change the exit code,
# so alerting can never cost the run work it would otherwise have done.
#
# Before this existed, a totally failed run and a perfect one were
# indistinguishable from outside: both logged, both wrote a heartbeat, both
# exited 0. Six days of complete failure passed unnoticed as a result.
if (( ${#FAILURES[@]} > 0 )); then
  log "FAIL: discovery run finished with ${#FAILURES[@]} failure(s):"
  for _f in "${FAILURES[@]}"; do
    log "  - $_f"
  done
  notify "Compute Atlas discovery FAILED" "${#FAILURES[@]} failure(s): ${FAILURES[*]}"
  exit 1
fi

log "discovery run OK — no failures"
exit 0
