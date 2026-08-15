#!/usr/bin/env bash
# Scheduled harness for the discovery pipeline. Fail-closed by default: does
# nothing unless DISCOVERY_ENABLED=true. Never writes live facilities — the
# submit step only ever POSTs to /api/submissions (Phase 4 staging queue),
# and the discovery step itself is read-only research. Never git commits or
# pushes. Intended to be run by launchd (see com.compute-atlas.discovery.plist)
# or manually for testing.
set -euo pipefail

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
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
# failure path below now does two things a human/launchd actually sees:
#   1. fires a desktop notification (terminal-notifier, else osascript)
#   2. makes this script exit NONZERO, so launchd records a failed run too
# DISCOVERY_NOTIFY=false disables (1) for tests/CI. Notification is strictly
# best-effort: it is wrapped in `|| true` and can never fail the pipeline.
#
# RESIDUAL GAP (deliberate, documented): this only fires when run.sh actually
# RUNS. It cannot detect "launchd never fired at all" — that needs a separate
# watchdog job. The stale-heartbeat check below is the partial mitigation: it
# reports missed days on the next run that does happen.
notify() {
  local title="$1" message="$2" safe_title safe_message
  [[ "${DISCOVERY_NOTIFY:-true}" == "true" ]] || return 0
  # Strip quotes/backslashes/newlines — these strings are interpolated into an
  # AppleScript string literal below, and state/run-id values reach them.
  safe_title="$(printf '%s' "$title" | tr -d '"\\' | tr '\n' ' ')"
  safe_message="$(printf '%s' "$message" | tr -d '"\\' | tr '\n' ' ')"
  if command -v terminal-notifier >/dev/null 2>&1; then
    terminal-notifier -title "$safe_title" -message "$safe_message" \
      -group com.compute-atlas.discovery >/dev/null 2>&1 || true
  elif command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$safe_message\" with title \"$safe_title\"" \
      >/dev/null 2>&1 || true
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
# DISCOVERY_STATES overrides the list entirely (space-separated). That is the
# supported way to drive a targeted manual run without editing this file:
#   DISCOVERY_STATES="IA NE" STATES_PER_RUN=2 bash scripts/discovery/run.sh
DEFAULT_STATES="IA NE WA OR MN MO UT TX VA OH GA AZ NV NC PA IL WI IN OK WY NM LA"
read -r -a STATES <<< "${DISCOVERY_STATES:-$DEFAULT_STATES}"
if (( ${#STATES[@]} == 0 )); then
  log "WARN: DISCOVERY_STATES was set but empty — falling back to the default rotation"
  read -r -a STATES <<< "$DEFAULT_STATES"
fi
CURSOR_FILE="$LOG_DIR/cursor.txt"

# STATES_PER_RUN: how many states this invocation processes, each with its own
# claude call/submit. Default 2 (2026-08-14, ~3x daily-output push — the other
# ~1.5x comes from the raised review cap below). Env-overridable for tests/
# tuning. Clamped to [1, ${#STATES[@]}] so a bad value (0, negative, or bigger
# than the rotation) can't loop forever or index out of STATES' bounds. With
# 15 states, a step of 2 doesn't divide evenly — pairings vary cycle to cycle,
# which is fine and intended, not a bug.
STATES_PER_RUN="${STATES_PER_RUN:-2}"
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
  # "Execution error" landed in the candidates file, so candidates_file_has_array
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

  # Explicit tool grants for the headless session. ~/.claude/settings.json only
  # allows WebFetch for github.com/raw.githubusercontent.com/api.github.com;
  # in `claude -p` there is no human to approve a permission prompt, so every
  # other WebFetch domain auto-denies. 2026-08-14 repro of the real prompt
  # produced 13 successful WebSearch calls but 3 denied WebFetch calls
  # ("Claude requested permissions to use WebFetch, but you haven't granted it
  # yet") plus a denied Read — crippling yield on a pipeline that is required
  # to cite real fetched sources. Read-only network fetch is the pipeline's
  # core need, and the same repro showed the model falling back to 14 `Bash`
  # calls shelling out to `curl` to work around the denied WebFetch — a
  # narrow `Bash(curl:*)` grant is added rather than blocking that, because
  # `curl` also reaches several bot-walled source domains (e.g. archive.org's
  # CDX API) that WebFetch cannot. NOTE this grant is NOT airtight: the
  # permission system also allows `curl -o`/`-O`, i.e. arbitrary file writes,
  # so an unattended run CAN write files despite `Write`/`Edit` being denied
  # below — this is a knowingly accepted residual risk (decided 2026-08-14),
  # accepted because curl is the only path to archive.org/CDX and thus to the
  # bot-walled sources Responsibility 4 depends on (509 counted by the
  # source-liveness check as of this decision). `Write`/`Edit`/`NotebookEdit`/
  # `Agent`/`Task` stay denied so an unattended run structurally cannot use
  # the file-editing tools directly, commit, or fan out sub-agents — the
  # prompt only asks for that in prose today. Kept as a shared array (both
  # invoke_claude branches below) so the two invocations can't drift,
  # expanded via the same bash-3.2-safe idiom as CAFFEINATE_PREFIX.
  # `Bash(curl:*)` contains a glob/parens and MUST stay a single array
  # element — never re-split this into a bare string.
  CLAUDE_TOOL_FLAGS=(--allowedTools "WebSearch WebFetch Read Glob Grep Bash(curl:*)" --disallowedTools "Write Edit NotebookEdit Agent Task")

  # Sets LAST_INVOKE_ELAPSED (seconds of wall-clock) on every path, so the
  # caller can tell an enforced cap from one that silently did nothing —
  # exit status cannot (see the -k measurement above).
  LAST_INVOKE_ELAPSED=0
  invoke_claude() {
    local _t0 _t1 _status=0
    _t0="$(date '+%s')"
    if [[ -n "$TIMEOUT_BIN" ]]; then
      "${CAFFEINATE_PREFIX[@]+"${CAFFEINATE_PREFIX[@]}"}" "$TIMEOUT_BIN" -k "$DISCOVERY_KILL_AFTER_SECS" "$DISCOVERY_TIMEOUT_SECS" claude -p "$PROMPT" --append-system-prompt "$BATCH_CONTRACT" "${CLAUDE_TOOL_FLAGS[@]+"${CLAUDE_TOOL_FLAGS[@]}"}" --output-format text < /dev/null > "$OUTFILE" || _status=$?
    else
      log "WARN: no timeout/gtimeout binary found — running claude without a wall-clock cap"
      "${CAFFEINATE_PREFIX[@]+"${CAFFEINATE_PREFIX[@]}"}" claude -p "$PROMPT" --append-system-prompt "$BATCH_CONTRACT" "${CLAUDE_TOOL_FLAGS[@]+"${CLAUDE_TOOL_FLAGS[@]}"}" --output-format text < /dev/null > "$OUTFILE" || _status=$?
    fi
    _t1="$(date '+%s')"
    LAST_INVOKE_ELAPSED=$(( _t1 - _t0 ))
    return "$_status"
  }

  # candidates_file_has_array: mirrors parseCandidatesJson's accept/reject
  # semantics exactly (raw array, or a preamble-tolerant [ .. ] slice) so a
  # legitimately empty `[]` result is never mistaken for a parse failure.
  candidates_file_has_array() {
    npx tsx -e '
import { parseCandidatesJson } from "./scripts/discovery/submit-candidates.ts";
import { readFileSync } from "node:fs";
try {
  const a = parseCandidatesJson(readFileSync(process.argv[1], "utf8"));
  process.exit(Array.isArray(a) ? 0 : 1);
} catch {
  process.exit(1);
}
' "$1" >/dev/null 2>&1
  }
fi

# --- self-reverting review cap ----------------------------------------------
# Burst: 25 candidates/day for the first BURST_DAYS days after BURST_START_DATE
# (a deliberate ~2-week catch-up while the daily review queue is fresh), then
# auto-revert to STEADY_CAP/day. No manual step to revert — the date does it.
# MAX_CANDIDATES in the environment always overrides (escape hatch / tests).
# Caps raised 2026-08-14 (10/5 -> 25/15, ~3x) once the timeout/permission fixes
# above restored real daily yield. Applied PER STATE below (a ceiling per
# submit call, not a per-batch total) — it is a ceiling, not a target;
# observed yield is ~10/state against a cap of 25, so covering multiple
# states per run does not mean e.g. 50 rows/day.
BURST_START_DATE="2026-07-30"   # date the self-reverting cap shipped
BURST_DAYS=20
BURST_CAP=25
STEADY_CAP=15

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

# note_overrun: the cap-did-not-enforce detector. Exit status cannot tell us
# this (a SIGTERM-ignoring process yields 124 whether it was capped at 2s or
# ran 31s — measured), so wall-clock is the only evidence.
note_overrun() {
  local label="$1" elapsed="$2"
  if (( elapsed > OVERRUN_LIMIT_SECS )); then
    log "WARN: $label ran ${elapsed}s wall-clock against a ${DISCOVERY_TIMEOUT_SECS}s cap (+${DISCOVERY_KILL_AFTER_SECS}s kill-after, +${DISCOVERY_OVERRUN_GRACE_SECS}s grace = ${OVERRUN_LIMIT_SECS}s limit) — the wall-clock cap did NOT enforce; likely machine sleep pausing ITIMER_REAL"
    FAILURES+=("$label: cap did not enforce (${elapsed}s > ${OVERRUN_LIMIT_SECS}s)")
    return 0
  fi
  return 1
}

for STATE in "${BATCH_STATES[@]}"; do
  RUN_ID="$(date '+%Y%m%dT%H%M%S')-${STATE}"
  RUN_IDS+=("$RUN_ID")
  log "starting discovery run $RUN_ID for state=$STATE"

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
    elif [[ "$INVOKE_STATUS" -ne 0 ]]; then
      log "WARN: claude invocation for $RUN_ID exited nonzero (session limit / timeout / crash, ${STATE_ELAPSED}s wall-clock) — output may be empty or an error string; submit may be skipped"
    fi
    note_overrun "claude invocation for $RUN_ID" "$STATE_ELAPSED" || true
    CLAUDE_ARRAY_OK=$(candidates_file_has_array "$OUTFILE" && echo true || echo false)

    # Bounded single retry: on 2026-07-15 the AZ run inherited the maintainer's
    # ~/.claude persona and ended its turn with a prose summary + journal write
    # instead of the JSON array — no array at all, not just malformed JSON. The
    # BATCH_CONTRACT above mitigates this but does not eliminate it, so retry
    # exactly once on a genuine no-array result, then proceed either way — the
    # submit step below skips (rather than crashes) on a still-empty/unparseable
    # OUTFILE, tracked via CLAUDE_ARRAY_OK.
    if [[ "$CLAUDE_ARRAY_OK" != "true" ]]; then
      log "WARN: claude output for $RUN_ID had no parseable JSON array — retrying once"
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
      CLAUDE_ARRAY_OK=$(candidates_file_has_array "$OUTFILE" && echo true || echo false)
      if [[ "$CLAUDE_ARRAY_OK" != "true" ]]; then
        log "WARN: retry for $RUN_ID still had no parseable JSON array — skipping submit"
      fi
    fi
  fi

  # --- submit step (deterministic — staging queue only) ---------------------
  # `if !` (never bare) so a nonzero submit exit for THIS state cannot trip
  # set -e and abort the remaining states in the batch.
  if [[ "$CLAUDE_ARRAY_OK" == "true" ]]; then
    log "submitting candidates from $OUTFILE"
    if ! npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts "$OUTFILE" \
      --run-id="$RUN_ID" \
      --max="${MAX_CANDIDATES:-$CAP}" \
      --state="$STATE" \
      ${API_BASE_URL:+--base-url="$API_BASE_URL"}; then
      log "WARN: submit-candidates failed for $RUN_ID (state=$STATE) — continuing with remaining states"
      FAILURES+=("$STATE: submit failed")
    fi
  else
    log "WARN: no parseable candidate array for $RUN_ID — skipping submit (nothing to stage)"
    # Dry-run never reaches here (it forces CLAUDE_ARRAY_OK=true), so this is
    # always a real no-array failure — exactly the state that went unnoticed
    # for six days.
    FAILURES+=("$STATE: no parseable candidate array")
  fi

  if [[ "${DISCOVERY_DRY_RUN:-false}" != "true" ]]; then
    HEARTBEAT_STATUS="no_array"
    [[ "$CLAUDE_ARRAY_OK" == "true" ]] && HEARTBEAT_STATUS="ok"
    HB_RUN_IDS+=("$RUN_ID")
    HB_STATES+=("$STATE")
    HB_STATUSES+=("$HEARTBEAT_STATUS")
    HB_ELAPSED+=("$STATE_ELAPSED")
  fi

  log "discovery run $RUN_ID complete"
done

# --- source-liveness check (read-only — runs ONCE per batch, after all
# states, including dry-run). Global, not per-state, and takes ~4 minutes —
# running it once per state would be pure waste. -----------------------------
log "checking source liveness"
if ! npx tsx --env-file=.env.local scripts/discovery/check-sources.ts 2>>"$LOG_DIR/check-sources.err"; then
  log "WARN: source-liveness check failed — continuing (see check-sources.err)"
fi

log "discovery batch complete: states=${BATCH_STATES[*]} run_ids=${RUN_IDS[*]}"

# Heartbeat: a visible "last real run" marker so a silent launchd skip/crash is
# obvious at a glance (stale lastRunAt = job not running; claudeStatus=no_array
# = the run reached claude but got a session-limit/prose reply, not candidates).
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
